/**
 * When the user speaks while cursor-agent is busy, nudge Nova to respond.
 */

import { getActiveAgentRun } from '../../executor/agentSingleton.js';

const MIN_USER_CHARS = 10;
const NUDGE_COOLDOWN_MS = 8_000;

let lastNudgeAt = 0;

/** Return narration to inject, or null if no nudge needed. */
export function userInterruptionNudge(userText: string): string | null {
  const text = userText.trim();
  if (text.length < MIN_USER_CHARS) return null;

  const active = getActiveAgentRun();
  if (!active) return null;

  const now = Date.now();
  if (now - lastNudgeAt < NUDGE_COOLDOWN_MS) return null;
  lastNudgeAt = now;

  const busyLabel = active.kind === 'ask' ? 'answering your question' : 'working on your task';
  return (
    `[Speak to user]: You heard the user while Cursor is ${busyLabel}. ` +
    'Respond to them now — answer any question. Use cursor_status if they ask about progress.'
  );
}

export function resetUserInterruptionNudge(): void {
  lastNudgeAt = 0;
}
