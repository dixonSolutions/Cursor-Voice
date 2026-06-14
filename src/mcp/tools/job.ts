/**
 * Job tools — cursor_status, cursor_stop
 *
 * Backed by SQLite job rows + in-memory job handles.
 */

import { getJob, getJobEvents } from '../../state/jobs.js';
import { stopJob } from '../../executor/jobManager.js';

// ── cursor_status ─────────────────────────────────────────────────────────

export interface StatusArgs {
  job_id: string;
}

export interface ProgressEntry {
  ts: string;
  kind: string;
  text: string | null;
}

export interface StatusResult {
  job_id: string;
  status: string;
  project: string;
  model: string | null;
  session_id: string | null;
  summary: string | null;
  diffstat: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  progress: ProgressEntry[];
}

export function handleCursorStatus(args: StatusArgs): StatusResult {
  const job = getJob(args.job_id);
  if (!job) {
    throw new Error(`Job "${args.job_id}" not found.`);
  }

  const events = getJobEvents(args.job_id);
  const progress: ProgressEntry[] = events.map((e) => {
    let text: string | null = null;
    if (e.payload) {
      try {
        const parsed = JSON.parse(e.payload) as Record<string, unknown>;
        text =
          typeof parsed['text'] === 'string'
            ? parsed['text']
            : typeof parsed['summary'] === 'string'
              ? parsed['summary']
              : typeof parsed['path'] === 'string'
                ? parsed['path']
                : e.payload;
      } catch {
        text = e.payload;
      }
    }
    return { ts: e.ts, kind: e.kind, text };
  });

  return {
    job_id: job.id,
    status: job.status,
    project: job.project,
    model: job.sessionId ? null : null, // model not stored per-job yet
    session_id: job.sessionId,
    summary: job.summary,
    diffstat: job.diffstat,
    error: job.error,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    progress,
  };
}

// ── cursor_stop ───────────────────────────────────────────────────────────

export interface StopArgs {
  job_id: string;
}

export interface StopResult {
  status: 'stopped' | 'not_running';
  job_id: string;
  message: string;
}

export function handleCursorStop(args: StopArgs): StopResult {
  const job = getJob(args.job_id);
  if (!job) {
    throw new Error(`Job "${args.job_id}" not found.`);
  }

  if (job.status !== 'running') {
    return {
      status: 'not_running',
      job_id: args.job_id,
      message: `Job is not running (status: ${job.status}).`,
    };
  }

  const stopped = stopJob(args.job_id);
  return {
    status: stopped ? 'stopped' : 'not_running',
    job_id: args.job_id,
    message: stopped ? 'Job stopped.' : 'Job was already finished.',
  };
}
