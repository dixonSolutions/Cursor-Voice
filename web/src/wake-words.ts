/** Client-side wake phrase matching — phrase from config via token mint only. */

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

export function isStartPhrase(text: string, start: string): boolean {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(start);
  if (!normPhrase) return false;
  if (normText === normPhrase) return true;
  return normText.startsWith(`${normPhrase} `);
}
