/**
 * Voice I/O tool handlers for the MCP SSE server exposed to Cursor.
 *
 * Cursor calls these tools to interact with the user over voice:
 *   speak(text)         — push text to TTS, forward audio to PWA
 *   done()              — signal PWA to re-arm mic for next wake word
 *   next_voice_turn()   — long-poll dequeue of next user utterance
 *
 * The `speak` path mirrors the llm_intelligence `onSpeak` callback: it sends
 * { type: "speak", text } to all connected intelligence WebSocket clients.
 *
 * See docs/16-mcp-server-cursor-as-brain.md.
 */

import { childLogger } from '../../log.js';
import { voiceTurnQueue } from './turnQueue.js';

const log = childLogger('mcp:server:voiceTools');

/** Tracks whether the current voice turn produced any speak() calls. */
let spokeThisTurn = false;

/** Reset at the start of each user turn (before the agent responds). */
export function resetTurnSpeakTracking(): void {
  spokeThisTurn = false;
}

export function hadSpeakThisTurn(): boolean {
  return spokeThisTurn;
}

// ── Session broadcast registry ────────────────────────────────────────────
//
// Intelligence WebSocket connections register here so speak() can push audio.

type SendFn = (payload: unknown) => void;

const activeSessions = new Set<SendFn>();

export function registerVoiceSession(send: SendFn): () => void {
  activeSessions.add(send);
  log.debug({ sessions: activeSessions.size }, 'voice session registered');
  return () => {
    activeSessions.delete(send);
    log.debug({ sessions: activeSessions.size }, 'voice session unregistered');
  };
}

function broadcast(payload: unknown): void {
  for (const send of activeSessions) {
    try {
      send(payload);
    } catch (err) {
      log.warn({ err }, 'broadcast to session failed');
    }
  }
}

const turnCompleteHooks = new Set<() => void>();

/** Called when Cursor invokes done() — clears server-side turn state. */
export function registerTurnCompleteHook(fn: () => void): () => void {
  turnCompleteHooks.add(fn);
  return () => {
    turnCompleteHooks.delete(fn);
  };
}

function notifyTurnComplete(): void {
  for (const fn of turnCompleteHooks) {
    try {
      fn();
    } catch (err) {
      log.warn({ err }, 'turn complete hook failed');
    }
  }
}

// ── Voice agent status broadcast ──────────────────────────────────────────

export interface VoiceAgentStatusPayload {
  runId: string;
  pid: number;
  sessionId: string | null;
  mcpSessionId?: string | null;
  state: 'starting' | 'running' | 'done' | 'error' | 'stopped';
  project: string;
}

/** Push voice agent lifecycle to all connected PWA sessions (debug/monitor). */
export function broadcastVoiceAgentStatus(payload: VoiceAgentStatusPayload): void {
  log.info(
    {
      runId: payload.runId,
      pid: payload.pid,
      sessionId: payload.sessionId,
      mcpSessionId: payload.mcpSessionId,
      state: payload.state,
    },
    'voice agent status',
  );

  broadcast({
    type: 'voice_agent_status',
    run_id: payload.runId,
    pid: payload.pid,
    session_id: payload.sessionId,
    mcp_session_id: payload.mcpSessionId ?? null,
    state: payload.state,
    project: payload.project,
  });
}

// ── Tool handlers ─────────────────────────────────────────────────────────

export interface SpeakArgs {
  text: string;
  /** When false, plays TTS but does not count as the agent having spoken this turn. */
  countTowardTurn?: boolean;
}

export interface SpeakResult {
  ok: boolean;
  sessions: number;
}

/**
 * speak(text) — called by Cursor to deliver a response to the user.
 * Broadcasts { type: "speak", text } to all connected PWA sessions.
 */
export function handleSpeak(args: SpeakArgs): SpeakResult {
  const text = (args.text ?? '').trim();
  if (!text) {
    return { ok: false, sessions: 0 };
  }

  if (args.countTowardTurn !== false) {
    spokeThisTurn = true;
  }
  log.info({ text: text.slice(0, 80), sessions: activeSessions.size }, 'speak called');
  // eslint-disable-next-line no-console
  console.log(`[voice] ◀ speak: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`);
  broadcast({ type: 'speak', text });
  broadcast({ type: 'assistant_transcript', text });

  return { ok: true, sessions: activeSessions.size };
}

export interface DoneResult {
  ok: boolean;
}

/**
 * done() — called by Cursor when it has finished speaking.
 * Sends turn_complete to all connected PWA sessions so the mic re-arms.
 */
export function handleDone(): DoneResult {
  broadcastVoiceTurnIdle();
  return { ok: true };
}

/** Re-arm PWA mic — after done() or when the voice agent process exits. */
export function broadcastVoiceTurnIdle(): void {
  spokeThisTurn = false;
  log.info('voice turn idle — re-arming mic');
  // eslint-disable-next-line no-console
  console.log('[voice] ✓ done — mic re-arming, waiting for next wake phrase');
  broadcast({ type: 'thinking', value: false });
  broadcast({ type: 'turn_complete' });
  notifyTurnComplete();
}

export interface NextVoiceTurnArgs {
  /** Maximum milliseconds to wait for a turn (default 30 000, max 60 000). */
  timeout_ms?: number;
}

export interface NextVoiceTurnResult {
  /** The transcribed text, or null if timeout elapsed with no turn. */
  turn: string | null;
  /** Whether the turn should interrupt in-progress work. */
  is_interrupt: boolean;
  /** ISO timestamp the turn was received, or null on timeout. */
  received_at: string | null;
  /** Turns still buffered after this dequeue. */
  queue_depth: number;
  /**
   * When the user barged in during TTS: lines fully heard, line cut off mid-playback,
   * and lines never spoken. Use this — the user did not hear your full last reply.
   */
  tts_interrupt?: {
    heard_complete: string[];
    heard_partial: string | null;
    not_spoken: string[];
  };
}

const MAX_POLL_MS = 60_000;
const DEFAULT_POLL_MS = 30_000;

/**
 * next_voice_turn() — long-poll dequeue.
 * Cursor calls this in a loop to receive the user's next utterance.
 * Returns immediately if a turn is already queued; otherwise suspends up to timeout_ms.
 */
export async function handleNextVoiceTurn(
  args: NextVoiceTurnArgs,
): Promise<NextVoiceTurnResult> {
  const timeoutMs = Math.min(
    args.timeout_ms != null && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_POLL_MS,
    MAX_POLL_MS,
  );

  broadcast({ type: 'thinking', value: true });

  const turn = await voiceTurnQueue.dequeue(timeoutMs);

  if (!turn) {
    return { turn: null, is_interrupt: false, received_at: null, queue_depth: 0 };
  }

  broadcast({
    type: 'tool_activity',
    tool: 'next_voice_turn',
    phase: 'done',
    label: 'Cursor received turn',
    detail: turn.text.slice(0, 120),
  });

  return {
    turn: turn.text,
    is_interrupt: turn.isInterrupt,
    received_at: turn.receivedAt,
    queue_depth: voiceTurnQueue.size,
    ...(turn.ttsInterrupt ? { tts_interrupt: turn.ttsInterrupt } : {}),
  };
}
