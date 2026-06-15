/**
 * Wake phrase matching — phrase text comes from config.json only.
 */

export interface WakeWords {
  start: string;
}

export function normalizeForWakeMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the utterance is the wake phrase or begins with it
 * ("start, I'd like…" when wake phrase is `start`).
 */
export function isStartPhrase(text: string, start: string): boolean {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(start);
  if (!normPhrase) return false;
  if (normText === normPhrase) return true;
  return normText.startsWith(`${normPhrase} `);
}
