/**
 * Amazon Bedrock Nova Sonic voice session — audio relay via bridge WebSocket.
 *
 * OpenAI uses browser WebRTC directly; Bedrock uses bridge-held AWS credentials
 * and InvokeModelWithBidirectionalStream on the server.
 */

import {
  unlockAudioContext,
  captureMicStream,
  createMicProcessingChain,
  applyMicNoiseGate,
  getSharedAudioContext,
  type MicProcessingChain,
} from './audio.js';
import { getVoiceAudioMeter } from './voice-audio-meter.js';
import type { SessionCallbacks } from './webrtc.js';
import {
  isStartPhrase,
  type WakeWords,
} from './wake-words.js';
import { speakTtsNow, stopAllTts } from './tts-fallback.js';

export type VoiceTransport = 'webrtc' | 'bedrock_ws';

export interface MintTokenResponse {
  token: string;
  sessionId: string;
  model: string;
  provider: string;
  transport: VoiceTransport;
  wakeWords?: WakeWords;
}

const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;
/** Below this RMS after gating, do not uplink — avoids Bedrock treating HVAC/noise as user speech. */
const UPLINK_SPEECH_RMS = 0.012;

export class BedrockVoiceSession {
  private ws: WebSocket | null = null;
  private micStream: MediaStream | null = null;
  private micChain: MicProcessingChain | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playbackCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private closed = false;
  private wakeWords: WakeWords = { start: '' };
  /** Drop mic uplink until wake phrase; while assistant speaks; or when input is only noise. */
  private voiceActivated = false;
  /** Drop mic uplink while assistant audio is playing (prevents TTS echo loops). */
  private serverSpeaking = false;
  private playbackEndTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackBus: GainNode | null = null;

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly cb: SessionCallbacks,
  ) {}

  async start(): Promise<void> {
    this.cb.onState('connecting');
    const mint = await this.mintToken();
    this.wakeWords = mint.wakeWords ?? { start: '' };

    await unlockAudioContext();
    this.micStream = await captureMicStream();
    this.playbackCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
    if (this.playbackCtx.state === 'suspended') {
      await this.playbackCtx.resume();
    }
    this.playbackBus = this.playbackCtx.createGain();
    const meter = getVoiceAudioMeter();
    const outTap = meter.tapPlayback(this.playbackCtx, this.playbackBus);
    outTap.connect(this.playbackCtx.destination);

    const wsUrl = `${this.bridgeBase.replace(/^http/, 'ws')}/ws/voice`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            type: 'auth',
            token: this.appToken,
            sessionId: mint.sessionId,
          }),
        );
      });
      ws.addEventListener('message', (ev) =>
        this.handleMessage(ev.data as string, {
          onConnected: () => finish(resolve),
          onError: (message) => finish(() => reject(new Error(message))),
        }),
      );
      ws.addEventListener('error', () =>
        finish(() => reject(new Error('Bedrock voice WebSocket error'))),
      );
      ws.addEventListener('close', (ev) => {
        if (!this.closed) this.cb.onClosed();
        finish(() =>
          reject(
            new Error(
              ev.reason?.trim() || `Bedrock voice WebSocket closed (${ev.code})`,
            ),
          ),
        );
      });
    });

    this.startMicCapture();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws?.send(JSON.stringify({ type: 'close' }));
    this.ws?.close();
    this.ws = null;
    for (const t of this.micStream?.getTracks() ?? []) t.stop();
    this.micStream = null;
    this.processor?.disconnect();
    this.processor = null;
    this.micChain?.dispose();
    this.micChain = null;
    if (this.playbackEndTimer) clearTimeout(this.playbackEndTimer);
    this.playbackEndTimer = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    void this.playbackCtx?.close();
    this.playbackCtx = null;
    this.playbackBus = null;
  }

  injectNarration(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !text.trim()) return;
    this.ws.send(JSON.stringify({ type: 'narration', content: text.trim() }));
  }

  private async mintToken(): Promise<MintTokenResponse> {
    const res = await fetch(`${this.bridgeBase}/api/realtime/token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Token mint failed (${res.status} ${res.statusText})`);
    }
    return res.json() as Promise<MintTokenResponse>;
  }

  private handleMessage(
    raw: string,
    hooks: { onConnected: () => void; onError: (message: string) => void },
  ): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      case 'connected':
        this.cb.onState('connected');
        hooks.onConnected();
        break;
      case 'user_transcript':
        if (typeof msg['text'] === 'string') {
          const text = msg['text'];
          this.cb.onUserTranscript(text);
          if (isStartPhrase(text, this.wakeWords.start)) {
            this.voiceActivated = true;
            this.cb.onActivated?.(this.wakeWords.start);
          }
        }
        break;
      case 'speak':
        if (typeof msg['text'] === 'string') {
          speakTtsNow(msg['text']);
        }
        break;
      case 'assistant_transcript':
        if (typeof msg['text'] === 'string') this.cb.onAssistantTranscript(msg['text']);
        break;
      case 'audio_out':
        if (typeof msg['content'] === 'string') {
          stopAllTts();
          this.playPcmBase64(msg['content']);
        }
        break;
      case 'speaking':
        if (typeof msg['value'] === 'boolean') {
          if (msg['value']) {
            this.serverSpeaking = true;
            this.cb.onSpeaking(true);
          } else {
            this.schedulePlaybackEndCheck();
          }
        }
        break;
      case 'working':
        if (typeof msg['value'] === 'boolean') {
          this.cb.onWorking(msg['value']);
        }
        break;
      case 'error':
        this.cb.onState('error');
        hooks.onError(
          typeof msg['message'] === 'string' ? msg['message'] : 'Voice connection failed',
        );
        break;
      case 'tool_activity':
        if (typeof msg['tool'] === 'string' && typeof msg['label'] === 'string') {
          const phase = msg['phase'];
          if (phase === 'start' || phase === 'done' || phase === 'error') {
            this.cb.onToolActivity?.({
              tool: msg['tool'],
              phase,
              label: msg['label'],
              detail: typeof msg['detail'] === 'string' ? msg['detail'] : undefined,
            });
          }
        }
        break;
    }
  }

  private startMicCapture(): void {
    if (!this.micStream) return;
    this.audioCtx = getSharedAudioContext();
    this.micChain = createMicProcessingChain(this.micStream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.isMicInputBlocked()) return;
      const input = ev.inputBuffer.getChannelData(0);
      const gated = new Float32Array(input);
      applyMicNoiseGate(this.micChain!, gated);
      if (computeRms(gated) < UPLINK_SPEECH_RMS) return;
      const pcm16 = downsampleTo16k(gated, this.audioCtx!.sampleRate);
      const b64 = pcm16ToBase64(pcm16);
      this.ws.send(JSON.stringify({ type: 'audio', content: b64 }));
    };
    const meter = getVoiceAudioMeter();
    const micTap = meter.tapMic(this.audioCtx, this.micChain.output);
    micTap.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);
  }

  private playPcmBase64(b64: string): void {
    if (!this.playbackCtx) return;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const samples = new Float32Array(bytes.length / 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    const buffer = this.playbackCtx.createBuffer(1, samples.length, OUTPUT_RATE);
    buffer.copyToChannel(samples, 0);
    const src = this.playbackCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playbackBus ?? this.playbackCtx.destination);
    const start = Math.max(this.playbackCtx.currentTime, this.nextPlayTime);
    src.start(start);
    this.nextPlayTime = start + buffer.duration;
    this.serverSpeaking = true;
    this.cb.onSpeaking(true);
    this.schedulePlaybackEndCheck();
  }

  /** Block mic until wake phrase, during assistant playback, or while TTS queue drains. */
  private isMicInputBlocked(): boolean {
    if (!this.voiceActivated) return true;
    if (this.serverSpeaking) return true;
    if (!this.playbackCtx) return false;
    return this.nextPlayTime > this.playbackCtx.currentTime + 0.35;
  }

  private schedulePlaybackEndCheck(): void {
    if (!this.playbackCtx) {
      this.serverSpeaking = false;
      this.cb.onSpeaking(false);
      return;
    }
    if (this.playbackEndTimer) clearTimeout(this.playbackEndTimer);
    const delayMs = Math.max(
      50,
      (this.nextPlayTime - this.playbackCtx.currentTime) * 1000 + 400,
    );
    this.playbackEndTimer = setTimeout(() => {
      this.playbackEndTimer = null;
      if (this.isMicInputBlocked()) {
        this.schedulePlaybackEndCheck();
        return;
      }
      this.serverSpeaking = false;
      this.cb.onSpeaking(false);
    }, delayMs);
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

function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === INPUT_RATE) {
    return floatToPcm16(input);
  }
  const ratio = inputRate / INPUT_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = Math.floor(i * ratio);
    const s = Math.max(-1, Math.min(1, input[idx] ?? 0));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
