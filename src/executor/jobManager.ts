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
import {
  assertAgentAvailable,
  killActiveAgent,
  registerAgentRun,
  releaseAgentRun,
} from './agentSingleton.js';
import { Watcher } from './watcher.js';
import { getNarrator } from './narrator.js';
import { checkpoint } from './git.js';
import { createJob, updateJob, getJob, type JobMode } from '../state/jobs.js';
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
/** Voice/control session key → currently running job id (for status/stop without job_id). */
const sessionActiveJobs = new Map<string, string>();
/** Monotonic start time for grace-period checks (Nova parallel tool calls). */
const jobStartedAtMs = new Map<string, number>();

/** How long a job must run before cursor_stop is honored (blocks Nova parallel stop spam). */
export const JOB_STOP_GRACE_MS = 15_000;

/** Number of currently running jobs. */
export function getActiveJobCount(): number {
  return activeJobs.size;
}

/** Resolve the running job id for a voice session, if any. */
export function getActiveJobIdForSession(sessionKey: string): string | null {
  const jobId = sessionActiveJobs.get(sessionKey);
  if (!jobId || !activeJobs.has(jobId)) return null;
  return jobId;
}

/** Live activity summary for the session's running job (for cursor_status intel). */
export function getActiveJobActivity(sessionKey: string): string | null {
  const jobId = getActiveJobIdForSession(sessionKey);
  if (!jobId) return null;
  return activeJobs.get(jobId)?.watcher.getActivitySummary() ?? null;
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

  // Enforce concurrency cap (config) and global singleton (one CLI process).
  if (activeJobs.size >= settings.maxConcurrentJobs) {
    throw new Error(
      `Concurrency limit reached (${settings.maxConcurrentJobs} job${settings.maxConcurrentJobs !== 1 ? 's' : ''} running). ` +
        'Wait for the current job to finish or call cursor_stop first.',
    );
  }
  assertAgentAvailable();

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
  registerAgentRun({ kind: 'job', refId: jobId, sessionKey, handle });
  updateJob(jobId, { pid: handle.pid });

  // Wire watcher → narrator.
  const watcher = new Watcher(jobId, project.name, () => {
    if (!settings.ghostKillEnabled) return;
    if (!activeJobs.has(jobId)) return;
    log.warn({ jobId, project: project.name }, 'ghost kill — terminating cursor-agent');
    stopJob(jobId, 'Stopped: agent tried to spawn subagents (budget protection)', 'error');
  });
  const narrator = getNarrator();
  watcher.onNarration((evt) => void narrator.receive(evt));
  handle.onEvent((evt) => watcher.process(evt));

  sessionActiveJobs.set(sessionKey, jobId);

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
      jobStartedAtMs.delete(jobId);
      releaseAgentRun(handle);
      if (sessionActiveJobs.get(sessionKey) === jobId) {
        sessionActiveJobs.delete(sessionKey);
      }
    }
  }, settings.jobTimeoutMs);

  activeJobs.set(jobId, { handle, watcher, timeoutTimer });
  jobStartedAtMs.set(jobId, Date.now());

  // Completion handler — runs in the background.
  void handle.result.then((result) => {
    clearTimeout(timeoutTimer);
    watcher.destroy();
    activeJobs.delete(jobId);
    jobStartedAtMs.delete(jobId);
    releaseAgentRun(handle);
    if (sessionActiveJobs.get(sessionKey) === jobId) {
      sessionActiveJobs.delete(sessionKey);
    }

    const existing = getJob(jobId);
    if (existing?.finishedAt) {
      log.debug({ jobId }, 'job already finalized — skipping completion update');
      return;
    }

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

/** Milliseconds since the job process started, or null if not active. */
export function getJobRunAgeMs(jobId: string): number | null {
  const started = jobStartedAtMs.get(jobId);
  return started !== undefined ? Date.now() - started : null;
}

// ── Stop ──────────────────────────────────────────────────────────────────

/**
 * Kill a running job. Noop if the job is not in the active handle map
 * (already finished or belongs to a previous bridge process).
 */
export function stopJob(
  jobId: string,
  reason = 'Stopped by user',
  status: 'stopped' | 'error' = 'stopped',
): boolean {
  const active = activeJobs.get(jobId);
  if (!active) {
    // Job row may exist but singleton still holds ask — try global kill for ask-only edge case.
    return false;
  }

  clearTimeout(active.timeoutTimer);
  active.handle.kill();
  active.watcher.destroy();
  activeJobs.delete(jobId);
  jobStartedAtMs.delete(jobId);
  releaseAgentRun(active.handle);

  for (const [sessionKey, id] of sessionActiveJobs.entries()) {
    if (id === jobId) sessionActiveJobs.delete(sessionKey);
  }

  updateJob(jobId, {
    status,
    error: reason,
    finishedAt: new Date().toISOString(),
  });

  log.info({ jobId, reason, status }, 'job stopped');
  return true;
}

// ── cursor_ask (one-shot, synchronous) ───────────────────────────────────

/**
 * Run cursor-agent in ask mode and wait for the answer.
 * Shares the global agent singleton with submit jobs.
 */
export async function askQuestion(
  project: Project,
  sessionKey: string,
  question: string,
): Promise<string> {
  assertAgentAvailable();

  const session = getSessionState(sessionKey);

  log.info({ project: project.name, sessionKey, question: question.slice(0, 120) }, 'cursor_ask started');

  const handle = spawnAgent({
    project,
    session,
    prompt: question,
    mode: 'ask',
    oneShot: true,
  });
  registerAgentRun({ kind: 'ask', refId: 'ask', sessionKey, handle });

  try {
    const result = await handle.result;

    if (result.exitCode !== 0) {
      throw new Error(result.error ?? `cursor-agent exited with code ${result.exitCode}`);
    }

    const answer = result.summary ?? 'No answer returned from cursor-agent.';
    log.info(
      { project: project.name, sessionKey, answerLen: answer.length },
      'cursor_ask completed',
    );
    return answer;
  } finally {
    releaseAgentRun(handle);
  }
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
