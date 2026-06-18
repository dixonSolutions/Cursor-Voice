/**
 * Browser TTS fallback when assistant text arrives without active playback.
 * WebKit speechSynthesis first; Amazon Polly when WebKit is unavailable.
 */

import { speakAmazonPolly, stopAmazonTts } from './amazon-tts.js';
import { resolveTtsBackend, type IntelligenceAudioConfig } from './intelligence-audio.js';
import { canUseWebkitTts } from './webkit-capabilities.js';
import type { TtsInterruptSnapshot, TtsPlayContext, TtsPlayFn } from './tts-interrupt.js';

const SPEAK_PREFIX = /^\[Speak to user\]:\s*/i;
const MAX_TTS_CHARS = 900;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastSpokenText = '';
let lastSpokenAt = 0;
let voicesPrimed = false;
let transcriptTtsConfig: {
  bridgeBase: string;
  appToken: string;
  audio: IntelligenceAudioConfig;
} | null = null;

export type { TtsPlayContext, TtsPlayFn } from './tts-interrupt.js';

export function configureTranscriptTts(opts: {
  bridgeBase: string;
  appToken: string;
  audio: IntelligenceAudioConfig;
}): void {
  transcriptTtsConfig = opts;
}

export function clearTranscriptTts(): void {
  transcriptTtsConfig = null;
}

export function stripSpeakPrefix(text: string): string {
  return text.replace(SPEAK_PREFIX, '').trim();
}

export function textForSpeech(text: string): string {
  const clean = stripSpeakPrefix(text);
  if (clean.length <= MAX_TTS_CHARS) return clean;
  const cut = clean.slice(0, MAX_TTS_CHARS);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  const body = lastBreak > MAX_TTS_CHARS * 0.4 ? cut.slice(0, lastBreak + 1) : cut;
  return `${body.trimEnd()} …`;
}

/**
 * Sequential TTS queue — rapid speak() calls pile up and play one after another
 * without canceling in-flight audio. Tracks what was heard for barge-in interrupts.
 */
export class TtsPile {
  private readonly queue: string[] = [];
  private draining = false;
  private active = false;
  private hardStop = false;
  private onActiveChange: ((active: boolean) => void) | null = null;
  private readonly completedLines: string[] = [];
  private currentLine: string | null = null;
  private lineStarted = false;
  private lineAbort: AbortController | null = null;

  constructor(private readonly playLine: TtsPlayFn) {}

  setOnActiveChange(fn: (active: boolean) => void): void {
    this.onActiveChange = fn;
  }

  get pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  isActive(): boolean {
    return this.active || this.draining || this.queue.length > 0;
  }

  resetHeard(): void {
    this.completedLines.length = 0;
    this.currentLine = null;
    this.lineStarted = false;
  }

  enqueue(text: string): void {
    const clean = textForSpeech(text);
    if (!clean) return;
    this.queue.push(clean);
    void this.drain();
  }

  /** Stop playback and return what the user had heard so far. */
  interruptWithSnapshot(): TtsInterruptSnapshot {
    this.hardStop = true;
    this.lineAbort?.abort();

    const heardPartial =
      this.lineStarted && this.currentLine ? this.currentLine : null;
    const notSpoken = [...this.queue];
    if (this.currentLine && !this.lineStarted) {
      notSpoken.unshift(this.currentLine);
    }

    const snapshot: TtsInterruptSnapshot = {
      heard_complete: [...this.completedLines],
      heard_partial: heardPartial,
      not_spoken: notSpoken,
    };

    this.queue.length = 0;
    this.draining = false;
    this.currentLine = null;
    this.lineStarted = false;
    this.lineAbort = null;
    this.setActive(false);

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    stopAmazonTts();

    return snapshot;
  }

  interrupt(): void {
    this.interruptWithSnapshot();
    this.resetHeard();
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.onActiveChange?.(active);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.hardStop = false;
    this.setActive(true);

    try {
      while (this.queue.length > 0 && !this.hardStop) {
        const line = this.queue.shift()!;
        await this.playLineTracked(line);
      }
    } finally {
      this.draining = false;
      if (!this.hardStop && this.queue.length === 0) {
        this.setActive(false);
      } else if (!this.hardStop && this.queue.length > 0) {
        void this.drain();
      }
    }
  }

  private async playLineTracked(line: string): Promise<void> {
    this.currentLine = line;
    this.lineStarted = false;
    this.lineAbort = new AbortController();
    const signal = this.lineAbort.signal;

    try {
      await this.playLine(line, {
        onStart: () => {
          this.lineStarted = true;
        },
        signal,
      });
      if (!signal.aborted && !this.hardStop) {
        this.completedLines.push(line);
      }
    } catch (err) {
      if (!signal.aborted && !this.hardStop) {
        console.warn('[tts pile]', err);
      }
    } finally {
      this.currentLine = null;
      this.lineStarted = false;
      this.lineAbort = null;
    }
  }
}

function playWebkitLine(text: string, ctx?: TtsPlayContext): Promise<void> {
  return new Promise((resolve) => {
    if (!canUseWebkitTts()) {
      resolve();
      return;
    }
    if (ctx?.signal.aborted) {
      resolve();
      return;
    }

    prepareSpeechSynthesis();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;

    const finish = () => {
      ctx?.signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const onAbort = () => {
      window.speechSynthesis.cancel();
      finish();
    };

    ctx?.signal.addEventListener('abort', onAbort, { once: true });
    utter.onstart = () => {
      lastSpokenAt = Date.now();
      lastSpokenText = text;
      ctx?.onStart();
    };
    utter.onend = () => {
      window.speechSynthesis.cancel();
      finish();
    };
    utter.onerror = () => finish();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

async function playTranscriptLine(text: string, ctx?: TtsPlayContext): Promise<void> {
  const cfg = transcriptTtsConfig;
  const backend = cfg ? resolveTtsBackend(cfg.audio) : canUseWebkitTts() ? 'webkit' : 'none';

  if (backend === 'webkit') {
    await playWebkitLine(text, ctx);
    return;
  }
  if (backend === 'amazon_polly' && cfg) {
    await speakAmazonPolly(text, cfg.bridgeBase, cfg.appToken, ctx);
    lastSpokenAt = Date.now();
    lastSpokenText = text;
    return;
  }
  if (canUseWebkitTts()) {
    await playWebkitLine(text, ctx);
    return;
  }
  if (cfg?.audio.amazonAvailable) {
    await speakAmazonPolly(text, cfg.bridgeBase, cfg.appToken, ctx);
    lastSpokenAt = Date.now();
    lastSpokenText = text;
  }
}

const transcriptPile = new TtsPile((text, ctx) => playTranscriptLine(text, ctx));

function prepareSpeechSynthesis(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.resume();
  if (!voicesPrimed) {
    window.speechSynthesis.getVoices();
    voicesPrimed = true;
  }
}

function canPlayTranscriptTts(): boolean {
  if (canUseWebkitTts()) return true;
  const cfg = transcriptTtsConfig;
  return Boolean(cfg?.audio.amazonAvailable && cfg.audio.ttsFallback === 'amazon_polly');
}

/** Enqueue browser TTS — lines pile and play sequentially. */
export function speakTtsNow(text: string): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  const clean = textForSpeech(text);
  if (!clean || !canPlayTranscriptTts()) return;
  if (clean === lastSpokenText && Date.now() - lastSpokenAt < 10_000) return;

  transcriptPile.enqueue(clean);
}

/**
 * Fallback when assistant text arrives without active TTS playback.
 */
export function scheduleTtsFallback(text: string, isSpeaking: () => boolean): void {
  const trimmed = text.trim();
  if (!trimmed || !canPlayTranscriptTts()) return;

  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (isSpeaking()) return;
    if (Date.now() - lastSpokenAt < 400) return;
    speakTtsNow(trimmed);
  }, SPEAK_PREFIX.test(trimmed) ? 200 : 800);
}

export function cancelTtsFallback(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

export function stopAllTts(): void {
  cancelTtsFallback();
  transcriptPile.interrupt();
}
