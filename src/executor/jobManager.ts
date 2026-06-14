/**
 * Job Manager — the bridge between MCP execute tools and the executor layer.
 *
 * Responsibilities:
 *   - Enforce concurrency cap (from config.settings.maxConcurrentJobs).
 *   - Take git checkpoint before each submit.
 *   - Create job DB row, spawn cursor-agent, wire watcher + narrator.
 *   - Apply per-job timeout; kill + mark error on expiry.
 *   - Persist resume_id from the run's session_id on completion.
 *   - Keep in-memory map of active handles (cleared on completion).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import { spawnAgent } from './cursorAgent.js';
import { Watcher } from './watcher.js';
import { getNarrator } from './narrator.js';
import { checkpoint } from './git.js';
import { createJob, updateJob, type JobMode } from '../state/jobs.js';
import { setProjectResumeId, getSessionState, type Project } from '../state/registry.js';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import type { AgentHandle } from './cursorAgent.js';

const execFileAsync = promisify(execFile);
const log = childLogger('job-manager');

// ── In-memory active handles ──────────────────────────────────────────────

interface ActiveJob {
  handle: AgentHandle;
  watcher: Watcher;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

const activeJobs = new Map<string, ActiveJob>();

/** Number of currently running jobs. */
export function getActiveJobCount(): number {
  return activeJobs.size;
}

// ── Submit ────────────────────────────────────────────────────────────────

export interface SubmitResult {
  jobId: string;
  project: string;
  sessionId: string | null;
  model: string;
  status: 'running';
}

/**
 * Submit a new cursor-agent job.
 * Returns immediately with a job_id; the job runs asynchronously.
 * Track progress with cursor_status(job_id).
 */
export async function submitJob(
  project: Project,
  sessionKey: string,
  prompt: string,
  mode: JobMode = 'agent',
): Promise<SubmitResult> {
  const { settings } = getConfig();
  const session = getSessionState(sessionKey);

  // Enforce concurrency cap.
  if (activeJobs.size >= settings.maxConcurrentJobs) {
    throw new Error(
      `Concurrency limit reached (${settings.maxConcurrentJobs} job${settings.maxConcurrentJobs !== 1 ? 's' : ''} running). ` +
        'Wait for the current job to finish or call cursor_stop first.',
    );
  }

  // Git checkpoint — record HEAD before any writes.
  let checkpointSha: string | null = null;
  try {
    const cp = await checkpoint(project.path);
    checkpointSha = cp.sha;
  } catch (err) {
    log.warn({ project: project.name, err }, 'git checkpoint failed (project may not be a git repo)');
  }

  // Create job row in DB.
  const jobId = createJob({
    project: project.name,
    prompt,
    mode,
    checkpoint: checkpointSha ?? undefined,
  });

  // Spawn the agent process.
  const handle = spawnAgent({ project, session, prompt, mode });
  updateJob(jobId, { pid: handle.pid });

  // Wire watcher → narrator.
  const watcher = new Watcher(jobId, project.name);
  const narrator = getNarrator();
  watcher.onNarration((evt) => void narrator.receive(evt));
  handle.onEvent((evt) => watcher.process(evt));

  // Per-job timeout.
  const timeoutTimer = setTimeout(() => {
    if (activeJobs.has(jobId)) {
      log.warn({ jobId, timeoutMs: settings.jobTimeoutMs }, 'job timed out — killing');
      handle.kill();
      updateJob(jobId, {
        status: 'error',
        error: `Job timed out after ${settings.jobTimeoutMs / 1000}s`,
        finishedAt: new Date().toISOString(),
      });
      watcher.destroy();
      activeJobs.delete(jobId);
    }
  }, settings.jobTimeoutMs);

  activeJobs.set(jobId, { handle, watcher, timeoutTimer });

  // Completion handler — runs in the background.
  void handle.result.then((result) => {
    clearTimeout(timeoutTimer);
    watcher.destroy();
    activeJobs.delete(jobId);

    updateJob(jobId, {
      status: result.exitCode === 0 ? 'done' : 'error',
      sessionId: result.sessionId,
      summary: result.summary,
      error: result.error,
      finishedAt: new Date().toISOString(),
    });

    if (result.sessionId) {
      setProjectResumeId(project.name, result.sessionId);
      log.info({ jobId, project: project.name, sessionId: result.sessionId }, 'resume id persisted');
    }
  });

  log.info({ jobId, project: project.name, mode, pid: handle.pid }, 'job submitted');

  return {
    jobId,
    project: project.name,
    sessionId: null, // not yet known — check cursor_status
    model: session.activeModel,
    status: 'running',
  };
}

// ── Stop ──────────────────────────────────────────────────────────────────

/**
 * Kill a running job. Noop if the job is not in the active handle map
 * (already finished or belongs to a previous bridge process).
 */
export function stopJob(jobId: string): boolean {
  const active = activeJobs.get(jobId);
  if (!active) return false;

  clearTimeout(active.timeoutTimer);
  active.handle.kill();
  active.watcher.destroy();
  activeJobs.delete(jobId);

  updateJob(jobId, {
    status: 'stopped',
    error: 'Stopped by user',
    finishedAt: new Date().toISOString(),
  });

  log.info({ jobId }, 'job stopped by user');
  return true;
}

// ── cursor_ask (one-shot, synchronous) ───────────────────────────────────

/**
 * Run cursor-agent in ask mode and wait for the answer.
 * Does NOT use the watcher/narrator (one-shot, no progress events needed).
 * Does NOT persist a resume_id (ask mode is stateless by design).
 */
export async function askQuestion(
  project: Project,
  sessionKey: string,
  question: string,
): Promise<string> {
  const session = getSessionState(sessionKey);

  const handle = spawnAgent({
    project,
    session,
    prompt: question,
    mode: 'ask',
  });

  const result = await handle.result;

  if (result.exitCode !== 0) {
    throw new Error(result.error ?? `cursor-agent exited with code ${result.exitCode}`);
  }

  return result.summary ?? 'No answer returned from cursor-agent.';
}

// ── Model list (cursor-agent models) ─────────────────────────────────────

export interface ModelEntry {
  id: string;
  displayName: string;
}

/**
 * Fetch the model list directly from cursor-agent (bypasses the cache).
 * Use the model cache helpers in state/models.ts for cached access.
 */
export async function fetchModelList(): Promise<ModelEntry[]> {
  const { stdout } = await execFileAsync('cursor-agent', ['models'], { timeout: 10_000 });
  return parseModelsOutput(stdout);
}

function parseModelsOutput(raw: string): ModelEntry[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.includes(' - ') &&
        !l.startsWith('Tip:') &&
        !l.startsWith('Available models') &&
        l.length > 0,
    )
    .map((l) => {
      const dashIdx = l.indexOf(' - ');
      return { id: l.slice(0, dashIdx).trim(), displayName: l.slice(dashIdx + 3).trim() };
    })
    .filter((m) => m.id.length > 0);
}
