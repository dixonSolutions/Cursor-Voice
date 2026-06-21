/**
 * Persisted heartbeat step log — one row per phase of a runHeartbeat() cycle.
 */

import { getDb } from './db.js';

export type HeartbeatEventStatus = 'ok' | 'skip' | 'warn' | 'error';

export interface HeartbeatEventRow {
  id: number;
  run_id: string;
  ts: string;
  step: string;
  status: HeartbeatEventStatus;
  detail: string | null;
}

export function addHeartbeatEvent(params: {
  runId: string;
  step: string;
  status: HeartbeatEventStatus;
  detail?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO heartbeat_event (run_id, step, status, detail)
       VALUES (@runId, @step, @status, @detail)`,
    )
    .run({
      runId: params.runId,
      step: params.step,
      status: params.status,
      detail: params.detail ?? null,
    });
}

export function listHeartbeatEvents(limit = 50): HeartbeatEventRow[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  return getDb()
    .prepare(
      `SELECT id, run_id, ts, step, status, detail
       FROM heartbeat_event
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(capped) as HeartbeatEventRow[];
}
