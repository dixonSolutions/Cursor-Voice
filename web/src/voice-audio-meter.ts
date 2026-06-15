/**
 * Real-time mic / playback analysis for the voice orb visualizer.
 *
 * Uses Web Audio AnalyserNode + getByteFrequencyData for ChatGPT-style radial
 * waves. Still when silent; reacts to your voice and AI playback.
 */

export interface AudioSpectrum {
  /** Normalized frequency bins (0–1) — drives the radial wave shape. */
  bins: readonly number[];
  mic: number;
  out: number;
  active: number;
}

const VIZ_BINS = 32;
const SILENT_FLOOR = 0.04;

function rmsFromTimeDomain(buf: Uint8Array): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
}

export class VoiceAudioMeter {
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private micTimeBuf = new Uint8Array(0);
  private outTimeBuf = new Uint8Array(0);
  private micFreqBuf = new Uint8Array(0);
  private outFreqBuf = new Uint8Array(0);
  private displayBins = new Float32Array(VIZ_BINS);
  private smoothedMic = 0;
  private smoothedOut = 0;

  /** Tap mic — connect `source → returned node → rest of graph`. */
  tapMic(ctx: AudioContext, source: AudioNode): AudioNode {
    this.micAnalyser?.disconnect();
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 128;
    this.micAnalyser.smoothingTimeConstant = 0.72;
    this.micTimeBuf = new Uint8Array(this.micAnalyser.fftSize);
    this.micFreqBuf = new Uint8Array(this.micAnalyser.frequencyBinCount);
    source.connect(this.micAnalyser);
    return this.micAnalyser;
  }

  /** Tap playback — connect `source → returned node → destination`. */
  tapPlayback(ctx: AudioContext, source: AudioNode): AudioNode {
    this.outAnalyser?.disconnect();
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 128;
    this.outAnalyser.smoothingTimeConstant = 0.68;
    this.outTimeBuf = new Uint8Array(this.outAnalyser.fftSize);
    this.outFreqBuf = new Uint8Array(this.outAnalyser.frequencyBinCount);
    source.connect(this.outAnalyser);
    return this.outAnalyser;
  }

  /** Sample frequency spectrum + levels at 60 fps. */
  sample(): AudioSpectrum {
    let mic = 0;
    let out = 0;

    if (this.micAnalyser && this.micFreqBuf.length > 0) {
      this.micAnalyser.getByteFrequencyData(this.micFreqBuf);
      this.micAnalyser.getByteTimeDomainData(this.micTimeBuf);
      mic = rmsFromTimeDomain(this.micTimeBuf);
    }
    if (this.outAnalyser && this.outFreqBuf.length > 0) {
      this.outAnalyser.getByteFrequencyData(this.outFreqBuf);
      this.outAnalyser.getByteTimeDomainData(this.outTimeBuf);
      out = rmsFromTimeDomain(this.outTimeBuf);
    }

    const micRise = mic > this.smoothedMic ? 0.45 : 0.18;
    const outRise = out > this.smoothedOut ? 0.5 : 0.2;
    this.smoothedMic += (mic - this.smoothedMic) * micRise;
    this.smoothedOut += (out - this.smoothedOut) * outRise;

    const micLen = this.micFreqBuf.length;
    const outLen = this.outFreqBuf.length;
    const maxLen = Math.max(micLen, outLen, 1);

    for (let i = 0; i < VIZ_BINS; i++) {
      const idx = Math.min(maxLen - 1, Math.floor((i / VIZ_BINS) * maxLen));
      const micV = micLen > 0 ? this.micFreqBuf[idx]! / 255 : 0;
      const outV = outLen > 0 ? this.outFreqBuf[idx]! / 255 : 0;
      let target = Math.max(micV, outV);
      if (target < SILENT_FLOOR) target = 0;
      else target = Math.min(1, (target - SILENT_FLOOR) / (1 - SILENT_FLOOR));

      const rise = target > this.displayBins[i]! ? 0.5 : 0.25;
      this.displayBins[i] += (target - this.displayBins[i]!) * rise;
    }

    return {
      bins: Array.from(this.displayBins),
      mic: this.smoothedMic,
      out: this.smoothedOut,
      active: Math.max(this.smoothedMic, this.smoothedOut),
    };
  }

  dispose(): void {
    this.micAnalyser?.disconnect();
    this.outAnalyser?.disconnect();
    this.micAnalyser = null;
    this.outAnalyser = null;
    this.displayBins.fill(0);
    this.smoothedMic = 0;
    this.smoothedOut = 0;
  }
}

let _meter: VoiceAudioMeter | null = null;

export function getVoiceAudioMeter(): VoiceAudioMeter {
  if (!_meter) _meter = new VoiceAudioMeter();
  return _meter;
}

export function disposeVoiceAudioMeter(): void {
  _meter?.dispose();
  _meter = null;
}

/** @deprecated Use AudioSpectrum */
export type AudioLevels = AudioSpectrum;
