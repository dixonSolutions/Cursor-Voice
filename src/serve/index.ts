/**
 * Serve — self-hosting auto-update sector.
 *
 * Optional scheduled (or manual) git pull → npm install → build → restart,
 * with every step logged to SQLite and pino. Disabled by default.
 *
 * See docs/21-serve-self-hosting.md
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { getConfig, type ServeSettings } from '../config.js';
import { childLogger } from '../log.js';
import { writeAudit } from '../state/db.js';
import {
  addServeEvent,
  type ServeEventStatus,
} from '../state/serveEvents.js';

const log = childLogger('serve');

export type ServeTrigger = 'manual' | 'scheduled';

export type ServeOutcome = 'ok' | 'skipped' | 'no_changes' | 'error';

export type ServeActionId = 'pull' | 'deps' | 'build' | 'restart' | 'health';

export interface ServeRunResult {
  runId: string;
  trigger: ServeTrigger;
  startedAt: string;
  finishedAt: string;
  outcome: ServeOutcome;
  summary: string;
}

export interface ServeActionResult {
  runId: string;
  outcome: ServeOutcome;
  detail: string;
}

export interface ServeGitSnapshot {
  repoDir: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  currentCommit: string | null;
}

export interface ServeStatus {
  running: boolean;
  schedulerActive: boolean;
  lastRun: ServeRunResult | null;
  git: ServeGitSnapshot | null;
}

let _running = false;
let _schedulerTimer: ReturnType<typeof setInterval> | null = null;
let _lastRun: ServeRunResult | null = null;
let _lastGit: ServeGitSnapshot | null = null;

function resolveRepoDir(settings: ServeSettings): string {
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
  status: ServeEventStatus,
  detail?: string,
): void {
  addServeEvent({ runId, step, status, detail });
  log.info({ runId, step, status, detail }, 'serve step');
  writeAudit({
    tool: 'serve',
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

async function probeGit(repoDir: string, branchHint?: string): Promise<ServeGitSnapshot> {
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

async function triggerRestart(repoDir: string, runId: string): Promise<ServeOutcome> {
  const watchActive = await isWatchPathActive();
  if (watchActive) {
    recordStep(runId, 'restart', 'skip', 'cursor-voice-watch.path will restart on dist change');
    return 'skipped';
  }
  const script = join(repoDir, 'scripts/restart.sh');
  if (!existsSync(script)) {
    recordStep(runId, 'restart', 'warn', `restart script missing at ${script}`);
    return 'error';
  }
  try {
    const child = spawn('bash', [script, '--no-build'], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    recordStep(runId, 'restart', 'ok', 'spawned scripts/restart.sh --no-build');
    return 'ok';
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'restart', 'error', detail);
    return 'error';
  }
}

function assertRepoDir(repoDir: string, runId: string): boolean {
  if (!existsSync(join(repoDir, 'package.json'))) {
    recordStep(runId, 'repo_check', 'error', 'package.json not found');
    return false;
  }
  return true;
}

async function stepGitPull(
  repoDir: string,
  hb: ServeSettings,
  runId: string,
  force = false,
): Promise<{ outcome: ServeOutcome; detail: string; pulled: boolean }> {
  const git = simpleGit({ baseDir: repoDir });
  let snapshot = await probeGit(repoDir, hb.branch);
  _lastGit = snapshot;
  recordStep(
    runId,
    'git_status',
    snapshot.dirty ? 'warn' : 'ok',
    `branch=${snapshot.branch} ahead=${snapshot.ahead} behind=${snapshot.behind} dirty=${snapshot.dirty}`,
  );

  if (snapshot.dirty && hb.abortOnLocalChanges && !force) {
    recordStep(runId, 'git_pull', 'skip', 'local changes detected — abortOnLocalChanges');
    return { outcome: 'skipped', detail: 'Skipped pull — local changes in working tree', pulled: false };
  }

  try {
    await git.fetch('origin');
    recordStep(runId, 'git_fetch', 'ok');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'git_fetch', 'error', detail);
    return { outcome: 'error', detail: `Git fetch failed — ${detail}`, pulled: false };
  }

  snapshot = await probeGit(repoDir, hb.branch);
  _lastGit = snapshot;

  if (snapshot.behind === 0) {
    recordStep(runId, 'git_pull', 'skip', 'already up to date with upstream');
    return { outcome: 'no_changes', detail: 'Already up to date with upstream', pulled: false };
  }

  if (!hb.autoPull && !force) {
    recordStep(runId, 'git_pull', 'skip', `behind=${snapshot.behind} but autoPull is disabled`);
    return { outcome: 'skipped', detail: 'Pull skipped — autoPull disabled', pulled: false };
  }

  try {
    const branch = hb.branch?.trim() || snapshot.branch;
    await git.pull('origin', branch);
    recordStep(runId, 'git_pull', 'ok', `pulled origin/${branch}`);
    _lastGit = await probeGit(repoDir, hb.branch);
    return { outcome: 'ok', detail: `Pulled origin/${branch}`, pulled: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'git_pull', 'error', detail);
    return { outcome: 'error', detail: `Git pull failed — ${detail}`, pulled: false };
  }
}

async function stepInstallDeps(
  repoDir: string,
  runId: string,
  force = false,
): Promise<{ outcome: ServeOutcome; detail: string }> {
  try {
    const { code, stderr } = await runCommand(repoDir, 'npm', [
      'install',
      '--no-audit',
      '--legacy-peer-deps',
    ]);
    if (code !== 0) {
      const detail = stderr.slice(0, 500) || `exit ${code}`;
      recordStep(runId, 'npm_install', 'error', detail);
      return { outcome: 'error', detail: 'npm install failed' };
    }
    // Native modules (better-sqlite3) must match the Node binary used by systemd.
    const rebuild = await runCommand(repoDir, 'npm', ['rebuild']);
    if (rebuild.code !== 0) {
      const detail = rebuild.stderr.slice(0, 500) || `exit ${rebuild.code}`;
      recordStep(runId, 'npm_rebuild', 'error', detail);
      return { outcome: 'error', detail: 'npm rebuild failed' };
    }
    recordStep(runId, 'npm_rebuild', 'ok');
    recordStep(runId, 'npm_install', 'ok', force ? 'manual' : 'lockfile changed');
    return { outcome: 'ok', detail: 'Dependencies installed and rebuilt' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'npm_install', 'error', detail);
    return { outcome: 'error', detail: `npm install failed — ${detail}` };
  }
}

async function stepBuild(
  repoDir: string,
  runId: string,
): Promise<{ outcome: ServeOutcome; detail: string }> {
  try {
    const { code, stderr } = await runCommand(repoDir, 'npm', ['run', 'build']);
    if (code !== 0) {
      const detail = stderr.slice(0, 500) || `exit ${code}`;
      recordStep(runId, 'npm_build', 'error', detail);
      return { outcome: 'error', detail: 'npm run build failed' };
    }
    recordStep(runId, 'npm_build', 'ok');
    return { outcome: 'ok', detail: 'Build completed' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'npm_build', 'error', detail);
    return { outcome: 'error', detail: `Build failed — ${detail}` };
  }
}

async function withServeLock<T>(
  label: string,
  fn: (runId: string) => Promise<T>,
): Promise<T> {
  if (_running) {
    throw new Error('Serve is already running');
  }
  _running = true;
  const runId = randomUUID();
  recordStep(runId, 'start', 'ok', label);
  try {
    return await fn(runId);
  } finally {
    _running = false;
  }
}

export async function refreshGitSnapshot(): Promise<ServeGitSnapshot> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);
  _lastGit = await probeGit(repoDir, settings.serve.branch);
  return _lastGit;
}

export function getServeStatus(): ServeStatus {
  return {
    running: _running,
    schedulerActive: _schedulerTimer !== null,
    lastRun: _lastRun,
    git: _lastGit,
  };
}

export async function serveGitPull(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const hb = settings.serve;
  const repoDir = resolveRepoDir(hb);

  return withServeLock('manual:pull', async (runId) => {
    if (!assertRepoDir(repoDir, runId)) {
      return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
    }
    const result = await stepGitPull(repoDir, hb, runId, true);
    recordStep(runId, 'finish', result.outcome === 'error' ? 'error' : 'ok', result.detail);
    return { runId, outcome: result.outcome, detail: result.detail };
  });
}

export async function serveInstallDeps(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:deps', async (runId) => {
    if (!assertRepoDir(repoDir, runId)) {
      return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
    }
    const result = await stepInstallDeps(repoDir, runId, true);
    recordStep(runId, 'finish', result.outcome === 'error' ? 'error' : 'ok', result.detail);
    return { runId, ...result };
  });
}

export async function serveBuild(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:build', async (runId) => {
    if (!assertRepoDir(repoDir, runId)) {
      return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
    }
    const result = await stepBuild(repoDir, runId);
    recordStep(runId, 'finish', result.outcome === 'error' ? 'error' : 'ok', result.detail);
    return { runId, ...result };
  });
}

export async function serveRestart(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:restart', async (runId) => {
    const outcome = await triggerRestart(repoDir, runId);
    const detail =
      outcome === 'ok'
        ? 'Restart spawned'
        : outcome === 'skipped'
          ? 'Watch path will handle restart'
          : 'Restart failed';
    recordStep(runId, 'finish', outcome === 'error' ? 'error' : 'ok', detail);
    return { runId, outcome, detail };
  });
}

export async function serveHealthCheck(): Promise<ServeActionResult> {
  const { env, settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:health', async (runId) => {
    try {
      await refreshGitSnapshot();
    } catch {
      // non-fatal
    }
    const health = await healthCheck(env.PORT);
    recordStep(
      runId,
      'health_check',
      health.ok ? 'ok' : 'warn',
      health.detail ?? 'ok',
    );
    const detail = health.ok
      ? `Healthy — ${repoDir}`
      : `Health check failed — ${health.detail ?? 'unknown'}`;
    recordStep(runId, 'finish', health.ok ? 'ok' : 'warn', detail);
    return {
      runId,
      outcome: health.ok ? 'ok' : 'error',
      detail,
    };
  });
}

export async function runServeAction(action: ServeActionId): Promise<ServeActionResult> {
  switch (action) {
    case 'pull':
      return serveGitPull();
    case 'deps':
      return serveInstallDeps();
    case 'build':
      return serveBuild();
    case 'restart':
      return serveRestart();
    case 'health':
      return serveHealthCheck();
    default:
      throw new Error(`Unknown serve action: ${String(action)}`);
  }
}

export async function runServe(trigger: ServeTrigger): Promise<ServeRunResult> {
  if (_running) {
    throw new Error('Serve is already running');
  }

  const { settings, env } = getConfig();
  const hb = settings.serve;

  if (trigger === 'scheduled' && !hb.enabled) {
    const skipped: ServeRunResult = {
      runId: randomUUID(),
      trigger,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: 'skipped',
      summary: 'Scheduled tick skipped — serve disabled in config',
    };
    _lastRun = skipped;
    return skipped;
  }

  _running = true;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const repoDir = resolveRepoDir(hb);
  let outcome: ServeOutcome = 'ok';
  let summary = 'Serve completed';
  const lockBefore = hashLockfile(repoDir);

  recordStep(runId, 'start', 'ok', `${trigger} — repo ${repoDir}`);

  try {
    if (!assertRepoDir(repoDir, runId)) {
      outcome = 'error';
      summary = 'Invalid repo directory — package.json missing';
      return finishRun(runId, trigger, startedAt, outcome, summary);
    }

    const pullResult = await stepGitPull(repoDir, hb, runId);
    if (pullResult.outcome === 'error') {
      return finishRun(runId, trigger, startedAt, 'error', pullResult.detail);
    }
    if (pullResult.outcome === 'skipped' && pullResult.detail.includes('local changes')) {
      return finishRun(runId, trigger, startedAt, 'skipped', pullResult.detail);
    }

    const lockAfter = hashLockfile(repoDir);
    const lockChanged = lockBefore !== null && lockAfter !== null && lockBefore !== lockAfter;

    if (lockChanged && hb.autoInstallDeps) {
      const depsResult = await stepInstallDeps(repoDir, runId);
      if (depsResult.outcome === 'error') {
        return finishRun(runId, trigger, startedAt, 'error', depsResult.detail);
      }
    } else if (lockChanged) {
      recordStep(runId, 'npm_install', 'skip', 'lockfile changed but autoInstallDeps disabled');
    } else {
      recordStep(runId, 'npm_install', 'skip', 'lockfile unchanged');
    }

    let built = false;
    if (hb.autoBuild) {
      const buildResult = await stepBuild(repoDir, runId);
      if (buildResult.outcome === 'error') {
        return finishRun(runId, trigger, startedAt, 'error', buildResult.detail);
      }
      built = true;
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

    const snapshot = _lastGit ?? (await probeGit(repoDir, hb.branch));
    if (pullResult.outcome === 'no_changes' && !built && !lockChanged) {
      outcome = 'no_changes';
      summary = 'No updates — repository already up to date';
    } else if (snapshot.behind === 0 && !built && !lockChanged) {
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
  trigger: ServeTrigger,
  startedAt: string,
  outcome: ServeOutcome,
  summary: string,
): ServeRunResult {
  const result: ServeRunResult = {
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

export function stopServeScheduler(): void {
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer);
    _schedulerTimer = null;
    log.info('serve scheduler stopped');
  }
}

export function reconcileServeScheduler(): void {
  stopServeScheduler();
  const { settings } = getConfig();
  if (!settings.serve.enabled) {
    return;
  }
  const intervalMs = settings.serve.intervalMs;
  _schedulerTimer = setInterval(() => {
    void runServe('scheduled').catch((err) => {
      log.error({ err }, 'scheduled serve failed');
    });
  }, intervalMs);
  log.info({ intervalMs }, 'serve scheduler started');
}

export async function startServeScheduler(): Promise<void> {
  try {
    await refreshGitSnapshot();
  } catch (err) {
    log.warn({ err }, 'initial git snapshot failed');
  }
  reconcileServeScheduler();
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
