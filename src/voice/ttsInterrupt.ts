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
  if (!heard_complete.length && !heard_partial && !not_spoken.length) {
    return undefined;
  }
  return { heard_complete, heard_partial, not_spoken };
}

export function summarizeTtsInterrupt(ctx: TtsInterruptContext): string {
  const parts: string[] = [];
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
