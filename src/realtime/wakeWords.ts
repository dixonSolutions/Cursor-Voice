/**
 * Configurable wake phrases for voice activation and stop.
 * Stored in config.json under settings.voice.wakeWords.
 */

export interface WakeWords {
  start: string;
  stop: string;
}

export const DEFAULT_WAKE_WORDS: WakeWords = {
  start: 'cursor listen',
  stop: 'cursor stop',
};

/** Normalize text for phrase matching (case-insensitive, collapse whitespace). */
export function normalizeForWakeMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common STT mishearings of "cursor listen" / "cursor stop". */
const FUZZY_START = /\b(cursor|curse or|casa|kasa|carter|tessa)\s+listen\b/;
const FUZZY_STOP = /\b(cursor|curse or|casa|kasa|carter|tessa)\s+stop\b/;

/** True when `text` contains the configured wake phrase. */
export function matchesWakePhrase(text: string, phrase: string): boolean {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(phrase);
  if (!normPhrase) return false;
  return normText.includes(normPhrase);
}

export function isStartPhrase(text: string, start: string): boolean {
  if (matchesWakePhrase(text, start)) return true;
  if (normalizeForWakeMatch(start) === 'cursor listen') {
    return FUZZY_START.test(normalizeForWakeMatch(text));
  }
  return false;
}

export function isStopPhrase(text: string, stop: string): boolean {
  if (matchesWakePhrase(text, stop)) return true;
  if (normalizeForWakeMatch(stop) === 'cursor stop') {
    return FUZZY_STOP.test(normalizeForWakeMatch(text));
  }
  return false;
}
