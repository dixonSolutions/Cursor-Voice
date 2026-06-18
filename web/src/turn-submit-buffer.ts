/**
 * Buffers STT finals until silence timeout, Silero VAD speech-end, or end wake phrase.
 */

import { stripEndPhrase } from './wake-words.js';

export type TurnSubmitReason = 'silence' | 'vad' | 'end_word';

export interface TurnSubmitBufferOptions {
  silenceMs: number;
  endPhrase?: string;
  onSubmit: (text: string, reason: TurnSubmitReason) => void;
  onBufferChange?: (text: string) => void;
}

export class TurnSubmitBuffer {
  private chunks: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: TurnSubmitBufferOptions) {}

  append(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.chunks.push(trimmed);
    this.opts.onBufferChange?.(this.text());
    this.scheduleSilenceSubmit();
  }

  /** Flush on VAD, end phrase, or external trigger. Returns true if a turn was sent. */
  submitNow(reason: TurnSubmitReason): boolean {
    this.clearTimer();
    const raw = this.text();
    if (!raw) return false;

    let cleaned = raw;
    if (reason === 'end_word' && this.opts.endPhrase?.trim()) {
      cleaned = stripEndPhrase(raw, this.opts.endPhrase);
      if (!cleaned) return false;
    }

    this.chunks = [];
    this.opts.onBufferChange?.('');
    this.opts.onSubmit(cleaned, reason);
    return true;
  }

  text(): string {
    return this.chunks.join(' ').trim();
  }

  dispose(): void {
    this.clearTimer();
    this.chunks = [];
  }

  private scheduleSilenceSubmit(): void {
    if (this.opts.silenceMs <= 0) return;
    this.clearTimer();
    this.timer = setTimeout(() => this.submitNow('silence'), this.opts.silenceMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
