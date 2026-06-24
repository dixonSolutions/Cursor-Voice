/**
 * TTS barge-in context — what the user actually heard before interrupting playback.
 */

export interface TtsInterruptContext {
  /** speak() lines fully played before interrupt. */
  heard_complete: string[];
  /** speak() line playing when interrupt fired (user heard an unknown prefix). */
  heard_partial: string | null;
  /** speak() lines queued but never started. */
  not_spoken: string[];
  /** Estimated words heard from the partial line (time-based). */
  partial_words_estimate?: string | null;
  /** Last N words the user heard — use this for continuity. */
  last_heard_words?: string;
}

export function parseTtsInterrupt(raw: unknown): TtsInterruptContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const heard_complete = Array.isArray(o['heard_complete'])
    ? o['heard_complete'].filter((x): x is string => typeof x === 'string')
    : [];
  const not_spoken = Array.isArray(o['not_spoken'])
    ? o['not_spoken'].filter((x): x is string => typeof x === 'string')
    : [];
  const heard_partial =
    typeof o['heard_partial'] === 'string' ? o['heard_partial'] : null;
  const partial_words_estimate =
    typeof o['partial_words_estimate'] === 'string' ? o['partial_words_estimate'] : null;
  const last_heard_words =
    typeof o['last_heard_words'] === 'string' ? o['last_heard_words'] : undefined;
  if (!heard_complete.length && !heard_partial && !not_spoken.length && !last_heard_words) {
    return undefined;
  }
  const ctx: TtsInterruptContext = {
    heard_complete,
    heard_partial,
    not_spoken,
    partial_words_estimate,
    last_heard_words,
  };
  if (!ctx.last_heard_words) {
    ctx.last_heard_words = computeLastHeardWords(ctx, 10);
  }
  return ctx;
}

/** Last N words from completed lines + partial estimate. */
export function computeLastHeardWords(ctx: TtsInterruptContext, maxWords = 10): string {
  const chunks = [...ctx.heard_complete];
  if (ctx.partial_words_estimate?.trim()) {
    chunks.push(ctx.partial_words_estimate.trim());
  }
  const words = chunks.join(' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return words.slice(-maxWords).join(' ');
}

export function summarizeTtsInterrupt(ctx: TtsInterruptContext): string {
  const parts: string[] = [];
  if (ctx.last_heard_words) {
    parts.push(`last heard: "${ctx.last_heard_words}"`);
  }
  if (ctx.heard_complete.length) {
    parts.push(`heard: ${ctx.heard_complete.join(' ')}`);
  }
  if (ctx.heard_partial) {
    parts.push(`cut off mid-line: "${ctx.heard_partial}"`);
  }
  if (ctx.not_spoken.length) {
    parts.push(`not spoken: ${ctx.not_spoken.length} line(s)`);
  }
  return parts.join('; ') || 'playback interrupted';
}
