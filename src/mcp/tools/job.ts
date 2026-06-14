/**
 * Job tools — cursor_status, cursor_stop
 *
 * Backed by SQLite job rows + in-memory job handles.
 */

import { getJob, getJobEvents } from '../../state/jobs.js';
import {
  getActiveJobActivity,
  getActiveJobIdForSession,
  getJobRunAgeMs,
  JOB_STOP_GRACE_MS,
  stopJob,
} from '../../executor/jobManager.js';
import { getActiveAgentRun } from '../../executor/agentSingleton.js';

// ── cursor_status ─────────────────────────────────────────────────────────

export interface StatusArgs {
  job_id?: string;
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
  /** What Cursor is doing right now (live, for running jobs). */
  activity: string | null;
  diffstat: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  progress: ProgressEntry[];
}

function resolveJobId(args: StatusArgs, sessionKey: string): string {
  const jobId = args.job_id ?? getActiveJobIdForSession(sessionKey);
  if (!jobId) {
    throw new Error(
      'No active job. Pass job_id or start work with cursor_submit first.',
    );
  }
  return jobId;
}

export function handleCursorStatus(args: StatusArgs, sessionKey: string): StatusResult {
  const jobId = resolveJobId(args, sessionKey);
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Job "${jobId}" not found.`);
  }

  const events = getJobEvents(jobId);
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

  const activity =
    job.status === 'running' ? getActiveJobActivity(sessionKey) : null;

  return {
    job_id: job.id,
    status: job.status,
    project: job.project,
    model: job.sessionId ? null : null,
    session_id: job.sessionId,
    summary: job.summary,
    activity,
    diffstat: job.diffstat,
    error: job.error,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    progress,
  };
}

// ── cursor_stop ───────────────────────────────────────────────────────────

export interface StopArgs {
  job_id?: string;
}

export interface StopResult {
  status: 'stopped' | 'not_running';
  job_id: string;
  message: string;
}

export function handleCursorStop(args: StopArgs, sessionKey: string): StopResult {
  const jobId = args.job_id ?? getActiveJobIdForSession(sessionKey);

  if (jobId) {
    const job = getJob(jobId);
    if (!job) {
      throw new Error(`Job "${jobId}" not found.`);
    }

    if (job.status !== 'running') {
      return {
        status: 'not_running',
        job_id: jobId,
        message: `Job is not running (status: ${job.status}).`,
      };
    }

    const runAgeMs = getJobRunAgeMs(jobId);
    if (runAgeMs !== null && runAgeMs < JOB_STOP_GRACE_MS) {
      return {
        status: 'not_running',
        job_id: jobId,
        message:
          `Job started ${Math.round(runAgeMs / 1000)}s ago — not cancelled. ` +
          'The wake phrase "cursor stop" is NOT cursor_stop. ' +
          'Wait for the job or ask the user to explicitly say "cancel the job".',
      };
    }

    const stopped = stopJob(jobId);
    return {
      status: stopped ? 'stopped' : 'not_running',
      job_id: jobId,
      message: stopped ? 'Job stopped.' : 'Job was already finished.',
    };
  }

  const active = getActiveAgentRun();
  if (active?.kind === 'ask') {
    return {
      status: 'not_running',
      job_id: 'ask',
      message:
        'A read-only question is in progress — wait for the answer. ' +
        'cursor_stop only cancels background jobs from cursor_submit, not cursor_ask.',
    };
  }

  throw new Error('No active job to stop.');
}
