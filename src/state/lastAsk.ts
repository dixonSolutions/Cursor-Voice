/**
 * In-memory cache of the last cursor_ask result per voice session.
 * Used for repeat/summary without re-spawning cursor-agent.
 */

export interface LastAskRecord {
  question: string;
  answer: string;
  project: string;
  completedAt: string;
}

const cache = new Map<string, LastAskRecord>();

export function setLastAsk(sessionKey: string, record: Omit<LastAskRecord, 'completedAt'>): void {
  cache.set(sessionKey, { ...record, completedAt: new Date().toISOString() });
}

export function getLastAsk(sessionKey: string): LastAskRecord | null {
  return cache.get(sessionKey) ?? null;
}

export function clearLastAsk(sessionKey: string): void {
  cache.delete(sessionKey);
}

/** Trim long answers for voice read-back — keeps bullet boundaries when possible. */
export function truncateForVoice(text: string, maxLen = 1200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;

  const cut = trimmed.slice(0, maxLen);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  const body = lastBreak > maxLen * 0.5 ? cut.slice(0, lastBreak + 1) : cut;
  return `${body.trimEnd()} … More detail available if the user asks to expand.`;
}
