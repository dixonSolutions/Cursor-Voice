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
  /** Interrupt ducking — 1 = full volume, lower while user captures after barge-in. */
  private interruptVolume = 1;
  private currentVolumeControl: import('./tts-interrupt.js').TtsVolumeControl | null = null;
  /** When true, barge-in deferred snapshot until user submits. */
  private deferredInterrupt = false;
  private baseVolume = 1;

  constructor(private readonly playLine: TtsPlayFn) {}

  setBaseVolume(volume: number): void {
    this.baseVolume = Math.max(0, Math.min(1, volume));
  }

  setOnActiveChange(fn: (active: boolean) => void): void {
    this.onActiveChange = fn;
  }

  get pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  isActive(): boolean {
    return this.active || this.draining || this.queue.length > 0;
  }

  isDeferredInterrupt(): boolean {
    return this.deferredInterrupt;
  }

  /** Line currently playing — used to ignore wake-word echo from assistant TTS. */
  getCurrentLine(): string | null {
    return this.currentLine;
  }

  resetHeard(): void {
    this.completedLines.length = 0;
    this.currentLine = null;
    this.lineStarted = false;
    this.deferredInterrupt = false;
    this.interruptVolume = 1;
  }

  enqueue(text: string): void {
    const clean = textForSpeech(text);
    if (!clean) return;
    this.queue.push(clean);
    void this.drain();
  }

  /**
   * Duck assistant speech on wake-word barge-in while TTS is playing.
   * Playback continues until submit (snapshot taken in finishDeferredInterrupt).
   * Returns true when deafen was applied (caller should not stop TTS).
   */
  deafen(factor: number): boolean {
    if (!this.isActive()) return false;
    this.deferredInterrupt = true;
    this.applyInterruptVolume(factor);
    return true;
  }

  /**
   * Restore full assistant volume after the user starts speaking their request.
   * Keeps deferred interrupt state so the heard snapshot is still taken on submit.
   */
  restoreInterruptVolume(): void {
    if (this.interruptVolume === 1) return;
    this.applyInterruptVolume(1);
  }

  private applyInterruptVolume(multiplier: number): void {
    this.interruptVolume = Math.max(0, Math.min(1, multiplier));
    this.currentVolumeControl?.setVolume(this.interruptVolume);

    // WebKit cannot change utter.volume mid-play — restart current line at new volume.
    if (this.currentLine && this.lineStarted) {
      const line = this.currentLine;
      this.lineAbort?.abort();
      this.queue.unshift(line);
      this.currentLine = null;
      this.lineStarted = false;
      if (!this.draining) void this.drain();
    }
  }

  /** Stop deferred interrupt — snapshot what was heard and halt playback. */
  finishDeferredInterrupt(): TtsInterruptSnapshot {
    this.deferredInterrupt = false;
    this.interruptVolume = 1;
    return this.interruptWithSnapshot();
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
    this.deferredInterrupt = false;
    this.interruptVolume = 1;
    this.currentVolumeControl = null;
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

    const volumeControl: import('./tts-interrupt.js').TtsVolumeControl = {
      setVolume: (multiplier: number) => {
        this.interruptVolume = Math.max(0, Math.min(1, multiplier));
      },
    };
    this.currentVolumeControl = volumeControl;

    try {
      await this.playLine(line, {
        onStart: () => {
          this.lineStarted = true;
        },
        signal,
        volume: volumeControl,
        baseVolume: this.baseVolume * this.interruptVolume,
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
      if (this.currentVolumeControl === volumeControl) {
        this.currentVolumeControl = null;
      }
    }
  }
}

function playWebkitLine(
  text: string,
  ctx?: TtsPlayContext,
  opts?: { rate?: number; pitch?: number; lang?: string; voiceURI?: string },
): Promise<void> {
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
    const rate = opts?.rate ?? 1.02;
    const pitch = opts?.pitch ?? 1;
    utter.rate = rate;
    utter.pitch = pitch;
    utter.lang = opts?.lang ?? 'en-US';
    if (opts?.voiceURI) {
      const voice = window.speechSynthesis
        .getVoices()
        .find((v) => v.voiceURI === opts.voiceURI);
      if (voice) utter.voice = voice;
    }
    utter.volume = ctx?.baseVolume ?? 1;

    const finish = () => {
      ctx?.signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const onAbort = () => {
      window.speechSynthesis.cancel();
      finish();
    };

    ctx?.signal.addEventListener('abort', onAbort, { once: true });

    const applyVolume = (multiplier: number) => {
      utter.volume = Math.max(0, Math.min(1, (ctx?.baseVolume ?? 1) * multiplier));
    };
    if (ctx?.volume) {
      const orig = ctx.volume.setVolume.bind(ctx.volume);
      ctx.volume.setVolume = (multiplier: number) => {
        orig(multiplier);
        applyVolume(multiplier);
      };
    }

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

/** Resume speechSynthesis and load voices — required on iOS before speak(). */
export function prepareSpeechSynthesisForPlayback(): void {
  prepareSpeechSynthesis();
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
