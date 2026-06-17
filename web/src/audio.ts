/**
 * Microphone capture and noise filtering for Cursor Voice PWA.
 *
 * - getUserMedia with browser DSP (noise suppression, echo cancellation, AGC)
 * - Web Audio high-pass filter — cuts leaf-blower / HVAC low-frequency rumble
 * - Soft noise gate — attenuates steady background when you're not speaking
 *
 * Bedrock sends raw PCM (no WebRTC codec DSP), so the filter chain matters most
 * there. WebRTC sessions use the same constraints + optional processed stream.
 *
 * See docs/06-voice-audio-webrtc.md — Background noise filtering.
 */

let _audioCtx: AudioContext | null = null;

/** Browser-native mic processing — always on when supported. */
export const MIC_MEDIA_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  // Chromium extras (ignored safely on Safari/Firefox)
  ...({
    googEchoCancellation: true,
    googAutoGainControl: true,
    googNoiseSuppression: true,
    googHighpassFilter: true,
  } as MediaTrackConstraints),
};

export interface MicFilterOptions {
  /** High-pass cutoff (Hz). Leaf blowers sit mostly below ~200 Hz. */
  highPassHz?: number;
  /** Attenuate steady background when RMS stays below the adaptive threshold. */
  noiseGateEnabled?: boolean;
}

const DEFAULT_FILTER: Required<MicFilterOptions> = {
  highPassHz: 180,
  noiseGateEnabled: true,
};

/**
 * Unlock the AudioContext inside a user-gesture handler.
 */
export async function unlockAudioContext(): Promise<void> {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  if (_audioCtx.state === 'suspended') {
    await _audioCtx.resume();
  }
}

/** Shared AudioContext for mic processing graphs. */
export function getSharedAudioContext(): AudioContext {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  return _audioCtx;
}

/** Request microphone with noise-suppression constraints enabled. */
export async function captureMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: MIC_MEDIA_CONSTRAINTS,
    video: false,
  });
}

/**
 * Adaptive noise gate — reduces steady rumble (leaf blowers, fans) between words.
 * Mutates samples in place.
 */
export class NoiseGate {
  private noiseFloor = 0.004;
  private readonly openMultiplier = 2.8;
  private readonly floorAlpha = 0.04;
  private readonly closedGain = 0;

  process(samples: Float32Array): void {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(samples.length, 1));
    const threshold = Math.max(this.noiseFloor * this.openMultiplier, 0.002);

    if (rms < threshold) {
      this.noiseFloor += (rms - this.noiseFloor) * this.floorAlpha;
      for (let i = 0; i < samples.length; i++) {
        samples[i] = (samples[i] ?? 0) * this.closedGain;
      }
    } else {
      this.noiseFloor += (rms * 0.15 - this.noiseFloor) * (this.floorAlpha * 0.25);
    }
  }
}

type MicChainInternal = {
  output: AudioNode;
  dispose: () => void;
  applyGate?: (buf: Float32Array) => void;
};

export interface MicProcessingChain {
  output: AudioNode;
  dispose(): void;
}

/** Mic → high-pass → output (apply gate in PCM callback for Bedrock). */
export function createMicProcessingChain(
  micStream: MediaStream,
  options: MicFilterOptions = {},
): MicProcessingChain {
  const opts = { ...DEFAULT_FILTER, ...options };
  const ctx = getSharedAudioContext();
  const source = ctx.createMediaStreamSource(micStream);
  const highPass = ctx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = opts.highPassHz;
  highPass.Q.value = 0.707;
  source.connect(highPass);

  const chain: MicChainInternal = {
    output: highPass,
    dispose: () => {
      source.disconnect();
      highPass.disconnect();
    },
  };

  if (opts.noiseGateEnabled) {
    const gate = new NoiseGate();
    chain.applyGate = (buf: Float32Array) => gate.process(buf);
  }

  return chain;
}

/** Run noise gate on a float buffer when the chain was created with gating enabled. */
export function applyMicNoiseGate(chain: MicProcessingChain, samples: Float32Array): void {
  (chain as MicChainInternal).applyGate?.(samples);
}

/**
 * Build a filtered MediaStream for WebRTC (high-pass + gate → new track).
 */
export function createFilteredMicStream(
  micStream: MediaStream,
  options?: MicFilterOptions,
): { stream: MediaStream; dispose: () => void } {
  const ctx = getSharedAudioContext();
  const chain = createMicProcessingChain(micStream, options) as MicChainInternal;
  const dest = ctx.createMediaStreamDestination();

  if (chain.applyGate) {
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    chain.output.connect(processor);
    processor.onaudioprocess = (ev) => {
      const output = ev.outputBuffer.getChannelData(0);
      output.set(ev.inputBuffer.getChannelData(0));
      chain.applyGate!(output);
    };
    processor.connect(dest);
    return {
      stream: dest.stream,
      dispose: () => {
        processor.disconnect();
        chain.dispose();
      },
    };
  }

  chain.output.connect(dest);
  return {
    stream: dest.stream,
    dispose: () => chain.dispose(),
  };
}

/** Create and attach an <audio> element for WebRTC remote-track playback. */
export function createAudioElement(): HTMLAudioElement {
  const el = document.createElement('audio');
  el.autoplay = true;
  el.setAttribute('playsinline', '');
  el.setAttribute('webkit-playsinline', '');
  document.body.appendChild(el);
  return el;
}

/**
 * ScriptProcessor nodes must be connected to the graph to run, but mic taps
 * must never play through speakers (causes echo and breaks wake-word detection).
 */
export function connectSilentSink(ctx: AudioContext, node: AudioNode): void {
  const silent = ctx.createGain();
  silent.gain.value = 0;
  node.connect(silent);
  silent.connect(ctx.destination);
}
