/**
 * Fires after `silenceMs` with no speech above RMS threshold (mic VAD).
 */

import { getSharedAudioContext, connectSilentSink } from './audio.js';

const SPEECH_RMS = 0.012;

export interface SilenceAfterSpeechOptions {
  silenceMs: number;
  onSilence: () => void;
}

export class SilenceAfterSpeechWatch {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly opts: SilenceAfterSpeechOptions) {}

  start(stream: MediaStream): void {
    this.stop();
    this.stream = stream;
    this.running = true;

    const ctx = getSharedAudioContext();
    this.source = ctx.createMediaStreamSource(stream);
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      const samples = event.inputBuffer.getChannelData(0);
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i] ?? 0;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / Math.max(samples.length, 1));
      if (rms >= SPEECH_RMS) {
        this.scheduleSilenceTimer();
      }
    };
    this.source.connect(this.processor);
    connectSilentSink(ctx, this.processor);
    this.scheduleSilenceTimer();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.processor = null;
    this.source = null;
    this.stream = null;
  }

  private scheduleSilenceTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.running) this.opts.onSilence();
    }, this.opts.silenceMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
