/**
 * Heartbeat — self-hosting auto-update sector.
 *
 * Optional scheduled (or manual) git pull → npm install → build → restart,
 * with every step logged to SQLite and pino. Disabled by default.
 *
 * See docs/21-heartbeat-self-hosting.md
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { getConfig, type HeartbeatSettings } from '../config.js';
import { childLogger } from '../log.js';
import { writeAudit } from '../state/db.js';
import {
  addHeartbeatEvent,
  type HeartbeatEventStatus,
} from '../state/heartbeatEvents.js';

const log = childLogger('heartbeat');

export type HeartbeatTrigger = 'manual' | 'scheduled';

export type HeartbeatOutcome = 'ok' | 'skipped' | 'no_changes' | 'error';

export interface HeartbeatRunResult {
  runId: string;
  trigger: HeartbeatTrigger;
  startedAt: string;
  finishedAt: string;
  outcome: HeartbeatOutcome;
  summary: string;
}

export interface HeartbeatGitSnapshot {
  repoDir: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  currentCommit: string | null;
}

export interface HeartbeatStatus {
  running: boolean;
  schedulerActive: boolean;
  lastRun: HeartbeatRunResult | null;
  git: HeartbeatGitSnapshot | null;
}

let _running = false;
let _schedulerTimer: ReturnType<typeof setInterval> | null = null;
let _lastRun: HeartbeatRunResult | null = null;
let _lastGit: HeartbeatGitSnapshot | null = null;

function resolveRepoDir(settings: HeartbeatSettings): string {
  return resolve(settings.repoDir?.trim() || process.cwd());
}

function hashLockfile(repoDir: string): string | null {
  const lockPath = join(repoDir, 'package-lock.json');
  if (!existsSync(lockPath)) return null;
  const buf = readFileSync(lockPath);
  return createHash('sha256').update(buf).digest('hex');
}

function recordStep(
  runId: string,
  step: string,
  status: HeartbeatEventStatus,
  detail?: string,
): void {
  addHeartbeatEvent({ runId, step, status, detail });
  log.info({ runId, step, status, detail }, 'heartbeat step');
  writeAudit({
    tool: 'heartbeat',
    result: status === 'error' ? 'error' : 'ok',
    reason: `${step}:${status}${detail ? ` — ${detail.slice(0, 120)}` : ''}`,
  });
}

function runCommand(
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function probeGit(repoDir: string, branchHint?: string): Promise<HeartbeatGitSnapshot> {
  const git = simpleGit({ baseDir: repoDir });
  const branch =
    branchHint?.trim() ||
    (await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => 'HEAD'));
  let status;
  try {
    status = await git.status();
  } catch {
    return {
      repoDir,
      branch,
      dirty: false,
      ahead: 0,
      behind: 0,
      currentCommit: null,
    };
  }
  let currentCommit: string | null = null;
  try {
    currentCommit = (await git.revparse(['HEAD'])).trim();
  } catch {
    currentCommit = null;
  }
  return {
    repoDir,
    branch: status.current || branch,
    dirty: !status.isClean(),
    ahead: status.ahead,
    behind: status.behind,
    currentCommit,
  };
}

async function isWatchPathActive(): Promise<boolean> {
  try {
    const { code } = await runCommand(process.cwd(), 'systemctl', [
      '--user',
      'is-active',
      'cursor-voice-watch.path',
    ]);
    return code === 0;
  } catch {
    return false;
  }
}

async function healthCheck(port: number): Promise<{ ok: boolean; detail?: string }> {
  const url = `http://127.0.0.1:${port}/healthz`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return { ok: false, detail: `${res.status} ${res.statusText}` };
    }
    const body = (await res.json()) as { status?: string };
    if (body.status !== 'ok') {
      return { ok: false, detail: `status=${String(body.status)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function triggerRestart(repoDir: string, runId: string): Promise<void> {
  const watchActive = await isWatchPathActive();
  if (watchActive) {
    recordStep(runId, 'restart', 'skip', 'cursor-voice-watch.path will restart on dist change');
    return;
  }
  const script = join(repoDir, 'scripts/restart.sh');
  if (!existsSync(script)) {
    recordStep(runId, 'restart', 'warn', `restart script missing at ${script}`);
    return;
  }
  try {
    const child = spawn('bash', [script, '--no-build'], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    recordStep(runId, 'restart', 'ok', 'spawned scripts/restart.sh --no-build');
  } catch (err) {
    recordStep(
      runId,
      'restart',
      'error',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function refreshGitSnapshot(): Promise<HeartbeatGitSnapshot> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.heartbeat);
  _lastGit = await probeGit(repoDir, settings.heartbeat.branch);
  return _lastGit;
}

export function getHeartbeatStatus(): HeartbeatStatus {
  return {
    running: _running,
    schedulerActive: _schedulerTimer !== null,
    lastRun: _lastRun,
    git: _lastGit,
  };
}

export async function runHeartbeat(
  trigger: HeartbeatTrigger,
): Promise<HeartbeatRunResult> {
  if (_running) {
    throw new Error('Heartbeat is already running');
  }

  const { settings, env } = getConfig();
  const hb = settings.heartbeat;

  if (trigger === 'scheduled' && !hb.enabled) {
    const skipped: HeartbeatRunResult = {
      runId: randomUUID(),
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: 'skipped',
      summary: 'Scheduled tick skipped — heartbeat disabled in config',
    };
    _lastRun = skipped;
    return skipped;
  }

  _running = true;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const repoDir = resolveRepoDir(hb);
  let outcome: HeartbeatOutcome = 'ok';
  let summary = 'Heartbeat completed';
  let lockBefore = hashLockfile(repoDir);

  recordStep(runId, 'start', 'ok', `${trigger} — repo ${repoDir}`);

  try {
    if (!existsSync(join(repoDir, 'package.json'))) {
      recordStep(runId, 'repo_check', 'error', 'package.json not found');
      outcome = 'error';
      summary = 'Invalid repo directory — package.json missing';
      return finishRun(runId, trigger, startedAt, outcome, summary);
    }

    const git = simpleGit({ baseDir: repoDir });
    let snapshot = await probeGit(repoDir, hb.branch);
    _lastGit = snapshot;
    recordStep(
      runId,
      'git_status',
      snapshot.dirty ? 'warn' : 'ok',
      `branch=${snapshot.branch} ahead=${snapshot.ahead} behind=${snapshot.behind} dirty=${snapshot.dirty}`,
    );

    if (snapshot.dirty && hb.abortOnLocalChanges) {
      recordStep(runId, 'git_pull', 'skip', 'local changes detected — abortOnLocalChanges');
      outcome = 'skipped';
      summary = 'Skipped pull — local changes in working tree';
      return finishRun(runId, trigger, startedAt, outcome, summary);
    }

    try {
      await git.fetch('origin');
      recordStep(runId, 'git_fetch', 'ok');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordStep(runId, 'git_fetch', 'error', detail);
      outcome = 'error';
      summary = `Git fetch failed — ${detail}`;
      return finishRun(runId, trigger, startedAt, outcome, summary);
    }

    snapshot = await probeGit(repoDir, hb.branch);
    _lastGit = snapshot;

    if (snapshot.behind === 0) {
      recordStep(runId, 'git_pull', 'skip', 'already up to date with upstream');
    } else if (!hb.autoPull) {
      recordStep(
        runId,
        'git_pull',
        'skip',
        `behind=${snapshot.behind} but autoPull is disabled`,
      );
    } else {
      try {
        const branch = hb.branch?.trim() || snapshot.branch;
        await git.pull('origin', branch);
        recordStep(runId, 'git_pull', 'ok', `pulled origin/${branch}`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordStep(runId, 'git_pull', 'error', detail);
        outcome = 'error';
        summary = `Git pull failed — ${detail}`;
        return finishRun(runId, trigger, startedAt, outcome, summary);
      }
    }

    snapshot = await probeGit(repoDir, hb.branch);
    _lastGit = snapshot;

    const lockAfter = hashLockfile(repoDir);
    const lockChanged = lockBefore !== null && lockAfter !== null && lockBefore !== lockAfter;

    if (lockChanged && hb.autoInstallDeps) {
      try {
        const { code, stderr } = await runCommand(repoDir, 'npm', [
          'install',
          '--no-audit',
          '--legacy-peer-deps',
        ]);
        if (code !== 0) {
          recordStep(runId, 'npm_install', 'error', stderr.slice(0, 500) || `exit ${code}`);
          outcome = 'error';
          summary = 'npm install failed';
          return finishRun(runId, trigger, startedAt, outcome, summary);
        }
        recordStep(runId, 'npm_install', 'ok', 'lockfile changed');
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordStep(runId, 'npm_install', 'error', detail);
        outcome = 'error';
        summary = `npm install failed — ${detail}`;
        return finishRun(runId, trigger, startedAt, outcome, summary);
      }
    } else if (lockChanged) {
      recordStep(runId, 'npm_install', 'skip', 'lockfile changed but autoInstallDeps disabled');
    } else {
      recordStep(runId, 'npm_install', 'skip', 'lockfile unchanged');
    }

    let built = false;
    if (hb.autoBuild) {
      try {
        const { code, stderr } = await runCommand(repoDir, 'npm', ['run', 'build']);
        if (code !== 0) {
          recordStep(runId, 'npm_build', 'error', stderr.slice(0, 500) || `exit ${code}`);
          outcome = 'error';
          summary = 'npm run build failed';
          return finishRun(runId, trigger, startedAt, outcome, summary);
        }
        recordStep(runId, 'npm_build', 'ok');
        built = true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordStep(runId, 'npm_build', 'error', detail);
        outcome = 'error';
        summary = `Build failed — ${detail}`;
        return finishRun(runId, trigger, startedAt, outcome, summary);
      }
    } else {
      recordStep(runId, 'npm_build', 'skip', 'autoBuild disabled');
    }

    if (built && hb.autoRestart) {
      await triggerRestart(repoDir, runId);
    } else if (built) {
      recordStep(runId, 'restart', 'skip', 'autoRestart disabled');
    }

    const health = await healthCheck(env.PORT);
    recordStep(
      runId,
      'health_check',
      health.ok ? 'ok' : 'warn',
      health.detail ?? 'ok',
    );

    if (snapshot.behind === 0 && !built && !lockChanged) {
      outcome = 'no_changes';
      summary = 'No updates — repository already up to date';
    }

    return finishRun(runId, trigger, startedAt, outcome, summary);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'fatal', 'error', detail);
    outcome = 'error';
    summary = detail;
    return finishRun(runId, trigger, startedAt, outcome, summary);
  } finally {
    _running = false;
  }
}

function finishRun(
  runId: string,
  trigger: HeartbeatTrigger,
  startedAt: string,
  outcome: HeartbeatOutcome,
  summary: string,
): HeartbeatRunResult {
  const result: HeartbeatRunResult = {
    runId,
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome,
    summary,
  };
  recordStep(runId, 'finish', outcome === 'error' ? 'error' : 'ok', summary);
  _lastRun = result;
  return result;
}

export function stopHeartbeatScheduler(): void {
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer);
    _schedulerTimer = null;
    log.info('heartbeat scheduler stopped');
  }
}

export function reconcileHeartbeatScheduler(): void {
  stopHeartbeatScheduler();
  const { settings } = getConfig();
  if (!settings.heartbeat.enabled) {
    return;
  }
  const intervalMs = settings.heartbeat.intervalMs;
  _schedulerTimer = setInterval(() => {
    void runHeartbeat('scheduled').catch((err) => {
      log.error({ err }, 'scheduled heartbeat failed');
    });
  }, intervalMs);
  log.info({ intervalMs }, 'heartbeat scheduler started');
}

export async function startHeartbeatScheduler(): Promise<void> {
  try {
    await refreshGitSnapshot();
  } catch (err) {
    log.warn({ err }, 'initial git snapshot failed');
  }
  reconcileHeartbeatScheduler();
}

export function spawnInstallSystemd(repoDir: string): { ok: boolean; detail: string } {
  const script = join(repoDir, 'scripts/install-systemd.sh');
  if (!existsSync(script)) {
    return { ok: false, detail: `Missing ${script}` };
  }
  const runId = randomUUID();
  recordStep(runId, 'install_systemd', 'ok', 'spawning install-systemd.sh');
  try {
    const child = spawn('bash', [script], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, detail: 'install-systemd.sh started in background' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'install_systemd', 'error', detail);
    return { ok: false, detail };
  }
}
