/**
 * Silero VAD (via @ricky0123/vad-web) — detects when the user has finished speaking.
 * Runs in the browser alongside the shared mic stream; does not stop mic tracks on pause.
 */

import { MicVAD } from '@ricky0123/vad-web';

import { getSharedAudioContext } from './audio.js';

export interface SileroVadCallbacks {
  onSpeechEnd?: () => void;
  onSpeechStart?: () => void;
  onError?: (message: string) => void;
}

export interface SileroVadStartOptions extends SileroVadCallbacks {
  /** Silence after speech before onSpeechEnd fires (maps to turnSubmit.silenceMs). */
  redemptionMs?: number;
}

export class SileroVadDetector {
  private micVad: MicVAD | null = null;

  async start(stream: MediaStream, opts: SileroVadStartOptions): Promise<void> {
    await this.dispose();

    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    try {
      this.micVad = await MicVAD.new({
        getStream: async () => stream,
        pauseStream: async () => {},
        resumeStream: async () => stream,
        audioContext: ctx,
        baseAssetPath: '/silero-vad/',
        onnxWASMBasePath: '/silero-vad/',
        startOnLoad: false,
        processorType: 'auto',
        redemptionMs: opts.redemptionMs ?? 1400,
        onSpeechEnd: () => opts.onSpeechEnd?.(),
        onSpeechStart: () => opts.onSpeechStart?.(),
      });
      await this.micVad.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.onError?.(message);
      throw err;
    }
  }

  pause(): void {
    void this.micVad?.pause();
  }

  resume(): void {
    void this.micVad?.start();
  }

  async dispose(): Promise<void> {
    if (this.micVad) {
      await this.micVad.destroy();
      this.micVad = null;
    }
  }
}
