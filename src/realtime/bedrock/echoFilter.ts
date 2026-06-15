/**
 * Drop user transcripts that are likely assistant TTS picked up by the mic.
 */

const ECHO_PATTERNS: RegExp[] = [
  /\blet me look into\b/i,
  /\bi'?ll ask cursor\b/i,
  /\bask cursor about\b/i,
  /\bsetting the project\b/i,
  /\bgive me about a minute\b/i,
  /\bchecking what cursor\b/i,
  /\bcursor is researching\b/i,
  /\bset up a cursor agent\b/i,
  /\bhow do i set up a cursor agent\b/i,
  /\bpulling up the last answer\b/i,
  /\bhere'?s the latest\b/i,
  /\bcursor finished\b/i,
  /^\[speak to user\]/i,
  /\bi understand you want\b/i,
  /\bhowever,? i need to use\b/i,
  /\blet me send this to cursor\b/i,
  /\bi'?ll send that to cursor\b/i,
];

/** Short junk STT from background noise — not intentional user commands. */
export function isLikelyNoiseTranscript(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  if (t.length <= 8 && !/\b(start|stop|summary|yes|no|help|cursor|ask)\b/i.test(t)) return true;
  return false;
}

export function isLikelyTtsEcho(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isLikelyNoiseTranscript(t) && t.length <= 8) return true;
  return ECHO_PATTERNS.some((p) => p.test(t));
}
