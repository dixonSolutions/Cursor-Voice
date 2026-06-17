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

// ── Tool handlers ─────────────────────────────────────────────────────────

export interface SpeakArgs {
  text: string;
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
  log.info('done called — re-arming mic');
  // eslint-disable-next-line no-console
  console.log('[voice] ✓ done — mic re-arming, waiting for next wake phrase');
  broadcast({ type: 'thinking', value: false });
  broadcast({ type: 'turn_complete' });
  notifyTurnComplete();
  return { ok: true };
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
  };
}
