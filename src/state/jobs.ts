/**
 * Job state management helpers.
 *
 * One row per cursor_submit invocation. Job events are the streaming progress
 * records used for narration and cursor_status responses.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';
import { childLogger } from '../log.js';

const log = childLogger('jobs');

// ── Types ─────────────────────────────────────────────────────────────────────

export type JobStatus = 'running' | 'done' | 'error' | 'stopped';
export type JobMode = 'agent' | 'plan' | 'ask';
export type JobEventKind =
  | 'job_started'
  | 'file_write'
  | 'file_read'
  | 'shell_run'
  | 'progress_tick'
  | 'job_done'
  | 'job_error'
  | 'ghost_killed'
  | 'system_init'
  | 'raw';

export interface Job {
  id: string;
  project: string;
  prompt: string;
  mode: JobMode;
  status: JobStatus;
  pid: number | null;
  sessionId: string | null;
  checkpoint: string | null;
  summary: string | null;
  diffstat: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  ts: string;
  kind: JobEventKind;
  payload: string | null;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  project: string;
  prompt: string;
  mode: string;
  status: string;
  pid: number | null;
  session_id: string | null;
  checkpoint: string | null;
  summary: string | null;
  diffstat: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    project: row.project,
    prompt: row.prompt,
    mode: row.mode as JobMode,
    status: row.status as JobStatus,
    pid: row.pid,
    sessionId: row.session_id,
    checkpoint: row.checkpoint,
    summary: row.summary,
    diffstat: row.diffstat,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/** Create a new job row (status = running). Returns the job id. */
export function createJob(params: {
  project: string;
  prompt: string;
  mode: JobMode;
  pid?: number;
  checkpoint?: string;
}): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO job (id, project, prompt, mode, status, pid, checkpoint)
       VALUES (@id, @project, @prompt, @mode, 'running', @pid, @checkpoint)`,
    )
    .run({
      id,
      project: params.project,
      prompt: params.prompt,
      mode: params.mode,
      pid: params.pid ?? null,
      checkpoint: params.checkpoint ?? null,
    });
  log.debug({ jobId: id, project: params.project, mode: params.mode }, 'job created');
  return id;
}

/** Fetch a job by ID. Returns null if not found. */
export function getJob(id: string): Job | null {
  const row = getDb().prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

/** Update mutable fields on a job. Undefined fields are not touched. */
export function updateJob(
  id: string,
  patch: Partial<{
    status: JobStatus;
    pid: number | null;
    sessionId: string | null;
    checkpoint: string | null;
    summary: string | null;
    diffstat: string | null;
    error: string | null;
    finishedAt: string | null;
  }>,
): void {
  const sets: string[] = [];
  const values: Record<string, unknown> = { id };

  if (patch.status !== undefined) {
    sets.push('status = @status');
    values['status'] = patch.status;
  }
  if (patch.pid !== undefined) {
    sets.push('pid = @pid');
    values['pid'] = patch.pid;
  }
  if (patch.sessionId !== undefined) {
    sets.push('session_id = @sessionId');
    values['sessionId'] = patch.sessionId;
  }
  if (patch.checkpoint !== undefined) {
    sets.push('checkpoint = @checkpoint');
    values['checkpoint'] = patch.checkpoint;
  }
  if (patch.summary !== undefined) {
    sets.push('summary = @summary');
    values['summary'] = patch.summary;
  }
  if (patch.diffstat !== undefined) {
    sets.push('diffstat = @diffstat');
    values['diffstat'] = patch.diffstat;
  }
  if (patch.error !== undefined) {
    sets.push('error = @error');
    values['error'] = patch.error;
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = @finishedAt');
    values['finishedAt'] = patch.finishedAt;
  }

  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE job SET ${sets.join(', ')} WHERE id = @id`)
    .run(values);
}

/** Mark all `running` jobs as `error` — called on bridge startup to reap orphans. */
export function markOrphanedJobs(): number {
  const result = getDb()
    .prepare(
      `UPDATE job SET
         status = 'error',
         error  = 'Bridge restarted — process lost',
         finished_at = datetime('now')
       WHERE status = 'running'`,
    )
    .run();
  if (result.changes > 0) {
    log.warn({ count: result.changes }, 'marked orphaned running jobs as error');
  }
  return result.changes;
}

// ── Job events ────────────────────────────────────────────────────────────────

/** Append a progress event for a job. */
export function addJobEvent(jobId: string, kind: JobEventKind, payload?: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO job_event (job_id, kind, payload) VALUES (@jobId, @kind, @payload)`,
    )
    .run({
      jobId,
      kind,
      payload: payload !== undefined ? JSON.stringify(payload) : null,
    });
}

/** Fetch all events for a job, ordered by insertion time. */
export function getJobEvents(jobId: string): JobEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM job_event WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as { id: number; job_id: string; ts: string; kind: string; payload: string | null }[];

  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    ts: r.ts,
    kind: r.kind as JobEventKind,
    payload: r.payload,
  }));
}

/** Return the most recent job for a project (any status). */
export function getLatestJobForProject(projectName: string): Job | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM job WHERE project = ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(projectName) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}
