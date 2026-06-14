/**
 * Global cursor-agent singleton — at most ONE CLI process for the whole bridge.
 *
 * Nova Sonic may emit parallel toolUse events; ask and submit used to spawn
 * independent processes. This gate ensures only one cursor-agent runs at a time.
 */

import { childLogger } from '../log.js';
import type { AgentHandle } from './cursorAgent.js';

const log = childLogger('agent-singleton');

export type AgentRunKind = 'ask' | 'job';

export interface ActiveAgentRun {
  kind: AgentRunKind;
  /** Job UUID or literal "ask". */
  refId: string;
  sessionKey: string;
  pid: number;
  handle: AgentHandle;
}

let active: ActiveAgentRun | null = null;

export function getActiveAgentRun(): Readonly<ActiveAgentRun> | null {
  return active;
}

export function isAgentBusy(): boolean {
  return active !== null;
}

/** Throw if a cursor-agent process is already running. Call before spawnAgent. */
export function assertAgentAvailable(): void {
  if (!active) return;
  const label = active.kind === 'ask' ? 'answering a question' : 'running a job';
  const hint =
    active.kind === 'ask'
      ? 'Wait for the answer — do not call cursor_stop or retry cursor_ask.'
      : 'Wait for it to finish or call cursor_stop to cancel the job.';
  throw new Error(`Cursor is already busy (${label}, pid ${active.pid}). ${hint}`);
}

/** Claim the singleton immediately after spawnAgent (before any await). */
export function registerAgentRun(params: {
  kind: AgentRunKind;
  refId: string;
  sessionKey: string;
  handle: AgentHandle;
}): void {
  if (active) {
    throw new Error('Agent singleton race — slot already held');
  }
  active = {
    kind: params.kind,
    refId: params.refId,
    sessionKey: params.sessionKey,
    pid: params.handle.pid,
    handle: params.handle,
  };
  log.info(
    { kind: params.kind, refId: params.refId, pid: params.handle.pid },
    'agent slot acquired',
  );
}

export function releaseAgentRun(handle: AgentHandle): void {
  if (active?.handle !== handle) return;
  log.info({ kind: active.kind, refId: active.refId, pid: active.pid }, 'agent slot released');
  active = null;
}

/** Kill whatever is running and clear the slot (cursor_stop / shutdown). */
export function killActiveAgent(reason: string): boolean {
  if (!active) return false;
  const { pid, kind, refId } = active;
  log.warn({ pid, kind, refId, reason }, 'killing active cursor-agent');
  active.handle.kill();
  active = null;
  return true;
}
