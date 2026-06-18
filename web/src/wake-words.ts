/** Client-side wake phrase matching — phrase from config via token mint only. */

export interface WakeWords {
  start: string;
  end: string;
}

export interface TurnSubmit {
  silenceMs: number;
  vadEnabled?: boolean;
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

/** Remove the wake prefix from an utterance that already matched isStartPhrase. */
export function stripStartPhrase(text: string, start: string): string {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(start);
  if (!normPhrase || normText === normPhrase) return '';
  if (!normText.startsWith(`${normPhrase} `)) return text.trim();

  const words = start.trim().split(/\s+/);
  const pattern = new RegExp(
    `^\\s*${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\s*`,
    'iu',
  );
  return text.replace(pattern, '').trim();
}

/** True when the utterance ends with the submit phrase ("… send"). */
export function isEndPhrase(text: string, end: string): boolean {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(end);
  if (!normPhrase) return false;
  if (normText === normPhrase) return true;
  return normText.endsWith(` ${normPhrase}`);
}

/** Start (wake) and end (submit) phrases must differ — same word breaks phased detection. */
export function phrasesConflict(start: string, end: string): boolean {
  const a = normalizeForWakeMatch(start);
  const b = normalizeForWakeMatch(end);
  if (!a || !b) return false;
  return a === b;
}

/** Remove a trailing submit phrase from an utterance. */
export function stripEndPhrase(text: string, end: string): string {
  const normText = normalizeForWakeMatch(text);
  const normPhrase = normalizeForWakeMatch(end);
  if (!normPhrase) return text.trim();
  if (normText === normPhrase) return '';
  if (!normText.endsWith(normPhrase)) return text.trim();

  const words = end.trim().split(/\s+/);
  const pattern = new RegExp(
    `\\s*${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\s*$`,
    'iu',
  );
  return text.replace(pattern, '').trim();
}
