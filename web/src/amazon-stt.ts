/**
 * Amazon Transcribe STT — utterance capture only (Vosk gates wake/end; no phrase matching here).
 *
 * Audio is buffered locally between beginCapture() and flushNow(). One Transcribe API call
 * per utterance. Optional VAD silence flush when no end phrase is configured.
 */

import {
  applyMicNoiseGate,
  captureMicStream,
  createMicProcessingChain,
  getSharedAudioContext,
  connectSilentSink,
  type MicProcessingChain,
} from './audio.js';
import { getVoiceAudioMeter } from './voice-audio-meter.js';
import {
  minPcmBytes,
  speechRmsThreshold,
  type SttGate,
} from './stt-gate.js';

const INPUT_RATE = 16_000;
const SILENCE_FRAMES = 28;
/** ~45s at 16 kHz — prevents runaway recordings when echo/VAD mis-fires. */
const MAX_PCM_SAMPLES = INPUT_RATE * 45;

export interface AmazonSttCallbacks {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
}

export class AmazonSttSession {
  private micStream: MediaStream | null = null;
  private ownsMic = false;
  private audioCtx: AudioContext | null = null;
  private micChain: MicProcessingChain | null = null;
  private processor: ScriptProcessorNode | null = null;
  private closed = false;
  private capturing = false;
  private silenceFlush = false;
  private utteranceFlushed = false;
  private recording = false;
  private silenceFrames = 0;
  private pcmChunks: Int16Array[] = [];
  private transcribing = false;

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly gate: SttGate,
    private readonly cb: AmazonSttCallbacks,
  ) {}

  async start(mediaStream?: MediaStream): Promise<void> {
    if (mediaStream) {
      this.micStream = mediaStream;
      this.ownsMic = false;
    } else {
      this.micStream = await captureMicStream();
      this.ownsMic = true;
    }
    this.audioCtx = getSharedAudioContext();
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    this.micChain = createMicProcessingChain(this.micStream, {
      highPassHz: 180,
      noiseGateEnabled: true,
    });
    const ctx = this.audioCtx;
    const tap = getVoiceAudioMeter().tapMic(ctx, this.micChain.output);
    connectSilentSink(ctx, tap);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => this.onAudio(ev);
    this.micChain.output.connect(this.processor);
    connectSilentSink(this.audioCtx, this.processor);
  }

  /** Stop accepting new audio but keep buffered PCM for flushNow(). */
  freezeCapture(): void {
    this.capturing = false;
    this.recording = false;
  }

  /** Start buffering mic audio for a single utterance (called after Vosk wake). */
  beginCapture(options?: { silenceFlush?: boolean }): void {
    this.capturing = true;
    this.silenceFlush = options?.silenceFlush ?? false;
    this.utteranceFlushed = false;
    this.recording = false;
    this.silenceFrames = 0;
    this.pcmChunks = [];
  }

  /** Stop buffering without transcribing (cancelled utterance). */
  endCapture(): void {
    this.capturing = false;
    this.recording = false;
    this.silenceFrames = 0;
    this.pcmChunks = [];
  }

  stop(): void {
    this.closed = true;
    this.capturing = false;
    this.processor?.disconnect();
    this.processor = null;
    this.micChain?.dispose();
    this.micChain = null;
    this.recording = false;
    this.silenceFrames = 0;
    this.pcmChunks = [];
    if (this.ownsMic) {
      for (const t of this.micStream?.getTracks() ?? []) t.stop();
    }
    this.micStream = null;
    this.ownsMic = false;
    this.pcmChunks = [];
  }

  /** Transcribe buffered audio once (Vosk end phrase or VAD silence). Returns transcript text. */
  async flushNowAsync(): Promise<string> {
    if (this.closed || this.transcribing || this.utteranceFlushed) {
      return '';
    }
    if (this.pcmChunks.length === 0) {
      throw new Error('No speech captured — speak after the wake phrase, then say the end phrase.');
    }
    return this.flushRecording();
  }

  flushNow(): void {
    void this.flushNowAsync().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.cb.onError?.(message);
    });
  }

  getMicStream(): MediaStream | null {
    return this.micStream;
  }

  setMicEnabled(enabled: boolean): void {
    this.micStream?.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  private onAudio(ev: AudioProcessingEvent): void {
    if (this.closed || !this.capturing || this.transcribing || this.utteranceFlushed) return;
    if (this.gate.isPaused()) return;
    if (!this.micChain || !this.audioCtx) return;

    const input = ev.inputBuffer.getChannelData(0);
    const gated = new Float32Array(input);
    applyMicNoiseGate(this.micChain, gated);
    const pcm = downsampleTo16k(gated, this.audioCtx.sampleRate);
    this.pcmChunks.push(pcm);

    const totalSamples = this.pcmChunks.reduce((n, c) => n + c.length, 0);
      if (totalSamples >= MAX_PCM_SAMPLES) {
        void this.flushRecording().catch(() => undefined);
        return;
      }

    if (!this.silenceFlush) return;

    const rms = computeRms(gated);
    const threshold = speechRmsThreshold(true);
    const speaking = rms >= threshold;

    if (speaking) {
      this.recording = true;
      this.silenceFrames = 0;
      return;
    }

    if (!this.recording) return;

    this.silenceFrames += 1;
    if (this.silenceFrames >= SILENCE_FRAMES) {
      void this.flushRecording().catch(() => undefined);
    }
  }

  private async flushRecording(): Promise<string> {
    if (this.transcribing || this.utteranceFlushed) return '';

    const chunks = this.pcmChunks;
    const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
    const minBytes = minPcmBytes(true);
    if (totalSamples * 2 < minBytes) {
      throw new Error('Speech too short — speak your request after the wake phrase.');
    }

    // Verify the gated PCM actually contains speech energy before calling the API.
    // The noise gate zeroes out non-speech frames, so a buffer with no energy
    // means the gate blocked everything (background noise was too loud).
    if (!hasSpeechEnergy(chunks)) {
      throw new Error(
        'Transcription returned no text — background noise may be too high. Try speaking louder or closer to the mic.',
      );
    }

    this.utteranceFlushed = true;
    this.pcmChunks = [];
    this.recording = false;
    this.silenceFrames = 0;

    const pcm = concatPcm16(chunks);
    this.transcribing = true;
    this.cb.onInterim?.('Transcribing…');

    try {
      const text = (await this.transcribe(pcm)).trim();
      if (text) {
        this.cb.onFinal(text);
        return text;
      }
      throw new Error('Transcription returned no text — speak clearly after the wake phrase.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cb.onError?.(message);
      throw err;
    } finally {
      this.transcribing = false;
    }
  }

  private async transcribe(pcm: Int16Array): Promise<string> {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i] ?? 0);
    }
    const b64 = btoa(binary);

    const res = await fetch(`${this.bridgeBase}/api/intelligence/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pcm: b64 }),
    });

    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }

    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  }
}

function computeRms(samples: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / Math.max(samples.length, 1));
}

/**
 * Returns true if the gated PCM buffer contains meaningful speech energy.
 * The noise gate zeroes out silent frames, so at least MIN_SPEECH_RATIO of samples
 * must be above a small amplitude threshold for the audio to be worth transcribing.
 */
function hasSpeechEnergy(chunks: Int16Array[]): boolean {
  // ~0.018 float amplitude in int16 — only non-silence gated-through samples qualify.
  const SPEECH_SAMPLE_THRESHOLD = 600;
  const MIN_SPEECH_RATIO = 0.05;
  let speech = 0;
  let total = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      if (Math.abs(chunk[i] ?? 0) > SPEECH_SAMPLE_THRESHOLD) speech++;
      total++;
    }
  }
  return total > 0 && speech / total >= MIN_SPEECH_RATIO;
}

function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === INPUT_RATE) return floatToPcm16(input);
  const ratio = inputRate / INPUT_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = Math.floor(i * ratio);
    out[i] = floatToPcm16Sample(input[srcIdx] ?? 0);
  }
  return out;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = floatToPcm16Sample(input[i] ?? 0);
  }
  return out;
}

function floatToPcm16Sample(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

function concatPcm16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
