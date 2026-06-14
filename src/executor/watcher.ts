/**
 * Stream-JSON watcher & event classifier.
 *
 * Receives raw cursor-agent stream-json events (from cursorAgent.ts) and:
 *   1. Classifies them into typed NarrationEvent kinds.
 *   2. Maintains a rolling JobSummary (accumulated across the run).
 *   3. Emits NarrationEvents with cadence limiting (max 1 per 15 s for ticks;
 *      significant transitions always emit immediately).
 *
 * See docs/12-stream-json-watcher.md for the full spec.
 */

import { getConfig } from '../config.js';
import { addJobEvent } from '../state/jobs.js';
import { childLogger } from '../log.js';

const log = childLogger('watcher');

// ── stream-json event shapes ──────────────────────────────────────────────

// Only the fields we act on — unknown fields are ignored (forward-compatible).
export type StreamJsonEvent =
  | { type: 'system'; subtype: 'init'; session_id: string; model?: string }
  | {
      type: 'assistant';
      subtype: 'tool_use_start';
      tool_call: Record<string, unknown>;
    }
  | {
      type: 'assistant';
      subtype: 'tool_use_done';
      tool_call: Record<string, unknown>;
      success?: boolean;
    }
  | { type: 'assistant'; message?: { content?: Array<{ text?: string }> } }
  | { type: 'result'; session_id?: string; usage?: unknown; message?: unknown }
  | { type: 'error'; message?: string }
  | { type: string; [key: string]: unknown };

// ── NarrationEvent ────────────────────────────────────────────────────────

export type NarrationKind =
  | 'job_started'
  | 'file_write'
  | 'file_read'
  | 'shell_run'
  | 'progress_tick'
  | 'job_done'
  | 'job_error'
  | 'ghost_killed';

export interface NarrationEvent {
  kind: NarrationKind;
  text: string;
  jobId: string;
  ts: Date;
}

// ── JobSummary ────────────────────────────────────────────────────────────

export interface JobSummary {
  filesRead: string[];
  filesWritten: string[];
  shellCommands: string[];
  lastThinking: string | null;
  elapsedMs: number;
  startedAt: Date;
}

// ── Tool call name extraction ─────────────────────────────────────────────

/**
 * Extract a human-readable tool name and path/cmd from a tool_call object.
 * The cursor-agent stream uses keys like `writeToolCall`, `readToolCall`,
 * `shellToolCall`, etc.
 */
function classifyToolCall(toolCall: Record<string, unknown>): {
  kind: 'write' | 'read' | 'shell' | 'other';
  label: string;
  path?: string;
  cmd?: string;
} {
  const keys = Object.keys(toolCall);

  for (const key of keys) {
    const lower = key.toLowerCase();
    const val = toolCall[key] as Record<string, unknown> | null;

    if (lower.includes('write')) {
      const path = val && typeof val['path'] === 'string' ? val['path'] : undefined;
      return { kind: 'write', label: path ? `wrote ${path}` : 'wrote a file', path };
    }
    if (lower.includes('read')) {
      const path = val && typeof val['path'] === 'string' ? val['path'] : undefined;
      return { kind: 'read', label: path ? `read ${path}` : 'read a file', path };
    }
    if (lower.includes('shell') || lower.includes('bash') || lower.includes('cmd')) {
      const cmd =
        val && typeof val['command'] === 'string'
          ? (val['command'] as string).slice(0, 60)
          : undefined;
      return { kind: 'shell', label: cmd ? `ran: ${cmd}` : 'ran a command', cmd };
    }
  }

  return { kind: 'other', label: 'called a tool' };
}

/** Detect Task/subagent/explore spawns — budget-burning "ghost agent" pattern. */
export function isGhostToolCall(toolCall: Record<string, unknown>): {
  ghost: boolean;
  reason: string | null;
} {
  for (const key of Object.keys(toolCall)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('task') ||
      lower.includes('subagent') ||
      lower.includes('explore') ||
      lower === 'tasktoolcall'
    ) {
      return { ghost: true, reason: key };
    }
  }

  const blob = JSON.stringify(toolCall).toLowerCase();
  if (
    blob.includes('subagent_type') ||
    blob.includes('"explore"') ||
    blob.includes('subagent_type":"explore')
  ) {
    return { ghost: true, reason: 'subagent_spawn' };
  }

  return { ghost: false, reason: null };
}

// ── Watcher ───────────────────────────────────────────────────────────────

export class Watcher {
  private readonly jobId: string;
  private readonly projectName: string;
  private readonly onGhostDetected: (() => void) | null;
  private readonly listeners: Array<(event: NarrationEvent) => void> = [];
  private readonly summary: JobSummary;

  private lastNarrationAt: number = 0;
  private cadenceMs: number;
  private cadenceTimer: ReturnType<typeof setTimeout> | null = null;
  private ghostTriggered = false;

  constructor(jobId: string, projectName: string, onGhostDetected?: () => void) {
    this.jobId = jobId;
    this.projectName = projectName;
    this.onGhostDetected = onGhostDetected ?? null;
    this.summary = {
      filesRead: [],
      filesWritten: [],
      shellCommands: [],
      lastThinking: null,
      elapsedMs: 0,
      startedAt: new Date(),
    };

    const { settings } = getConfig();
    this.cadenceMs = settings.narratorCadenceMs;
  }

  /** Subscribe to narration events. */
  onNarration(cb: (event: NarrationEvent) => void): void {
    this.listeners.push(cb);
  }

  /** Process one parsed stream-json event. */
  process(event: StreamJsonEvent): void {
    this.summary.elapsedMs = Date.now() - this.summary.startedAt.getTime();

    // ── system:init ────────────────────────────────────────────────────
    if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
      log.debug({ jobId: this.jobId, sessionId: event.session_id }, 'job started');
      addJobEvent(this.jobId, 'system_init', { sessionId: event.session_id });
      this.emit({
        kind: 'job_started',
        text: `Cursor started working on ${this.projectName}.`,
      });
      this.startCadenceTicks();
      return;
    }

    // ── tool_use_start ────────────────────────────────────────────────
    if (event.type === 'assistant' && 'subtype' in event && event.subtype === 'tool_use_start') {
      const toolCall = (event as { type: 'assistant'; subtype: 'tool_use_start'; tool_call: Record<string, unknown> }).tool_call;

      const ghost = isGhostToolCall(toolCall);
      if (ghost.ghost && !this.ghostTriggered) {
        this.ghostTriggered = true;
        this.stopCadenceTicks();
        const reason = ghost.reason ?? 'subagent';
        log.warn({ jobId: this.jobId, reason }, 'ghost agent tool detected — killing job');
        addJobEvent(this.jobId, 'ghost_killed', { reason });
        this.emit({
          kind: 'ghost_killed',
          text: `Stopped — Cursor tried to spawn extra agents (${reason}). Budget protection kicked in.`,
        });
        this.onGhostDetected?.();
        return;
      }

      const { kind, label, path, cmd } = classifyToolCall(toolCall);

      if (kind === 'write' && path) {
        this.summary.filesWritten.push(path);
        addJobEvent(this.jobId, 'file_write', { path });
        this.emit({ kind: 'file_write', text: `Cursor just wrote ${path}.` });
      } else if (kind === 'read' && path) {
        this.summary.filesRead.push(path);
        addJobEvent(this.jobId, 'file_read', { path });
        // Reads don't warrant an immediate narration — they're too frequent.
      } else if (kind === 'shell') {
        if (cmd) this.summary.shellCommands.push(cmd);
        addJobEvent(this.jobId, 'shell_run', { cmd, label });
        this.emit({ kind: 'shell_run', text: `Cursor is running: ${label}.` });
      }
      return;
    }

    // ── result (job done) ──────────────────────────────────────────────
    if (event.type === 'result') {
      this.stopCadenceTicks();
      const filesChanged = this.summary.filesWritten.length;
      const doneText =
        filesChanged > 0
          ? `Done — Cursor changed ${filesChanged} file${filesChanged !== 1 ? 's' : ''}. Want to see the diff?`
          : 'Done — Cursor finished with no file changes.';
      addJobEvent(this.jobId, 'job_done', { summary: doneText });
      this.emit({ kind: 'job_done', text: doneText });
      return;
    }

    // ── error ──────────────────────────────────────────────────────────
    if (event.type === 'error') {
      this.stopCadenceTicks();
      const msg =
        typeof (event as { type: 'error'; message?: string }).message === 'string'
          ? (event as { type: 'error'; message: string }).message
          : 'an unknown error';
      addJobEvent(this.jobId, 'job_error', { message: msg });
      this.emit({ kind: 'job_error', text: `Something went wrong. Cursor said: ${msg}` });
      return;
    }
  }

  /** Human-readable snapshot of what the agent is doing right now. */
  getActivitySummary(): string {
    const s = this.getSummary();
    const parts: string[] = [];
    if (s.filesWritten.length > 0) {
      const last = s.filesWritten[s.filesWritten.length - 1];
      parts.push(`last wrote ${last}`);
    }
    if (s.shellCommands.length > 0) {
      const last = s.shellCommands[s.shellCommands.length - 1];
      parts.push(`last ran ${last}`);
    }
    if (s.filesRead.length > 0 && parts.length === 0) {
      parts.push(`read ${s.filesRead.length} file${s.filesRead.length !== 1 ? 's' : ''} so far`);
    }
    if (parts.length === 0) {
      return 'Cursor started but no file activity yet.';
    }
    return parts.join('; ');
  }

  /** Return a snapshot of the current rolling summary. */
  getSummary(): Readonly<JobSummary> {
    this.summary.elapsedMs = Date.now() - this.summary.startedAt.getTime();
    return this.summary;
  }

  /** Stop timers (call when the job finishes or is killed). */
  destroy(): void {
    this.stopCadenceTicks();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Emit a NarrationEvent to all subscribers.
   * Transition events (file_write, shell_run, job_done, job_error) bypass
   * the cadence gate. Only progress_tick is gated.
   */
  private emit(params: { kind: NarrationKind; text: string }): void {
    const isGated = params.kind === 'progress_tick';
    const now = Date.now();

    if (isGated && now - this.lastNarrationAt < this.cadenceMs) {
      return; // Too soon for a tick — drop it
    }

    this.lastNarrationAt = now;
    const event: NarrationEvent = {
      ...params,
      jobId: this.jobId,
      ts: new Date(),
    };

    for (const cb of this.listeners) {
      cb(event);
    }
  }

  private startCadenceTicks(): void {
    const tick = (): void => {
      const s = this.getSummary();
      const parts: string[] = [];
      if (s.filesRead.length > 0) parts.push(`read ${s.filesRead.length} file${s.filesRead.length !== 1 ? 's' : ''}`);
      if (s.filesWritten.length > 0) parts.push(`written ${s.filesWritten.length}`);
      const detail = parts.length > 0 ? ` — ${parts.join(', ')} so far` : '';
      this.emit({ kind: 'progress_tick', text: `Still working${detail}.` });
      this.cadenceTimer = setTimeout(tick, this.cadenceMs);
    };
    this.cadenceTimer = setTimeout(tick, this.cadenceMs);
  }

  private stopCadenceTicks(): void {
    if (this.cadenceTimer) {
      clearTimeout(this.cadenceTimer);
      this.cadenceTimer = null;
    }
  }
}
