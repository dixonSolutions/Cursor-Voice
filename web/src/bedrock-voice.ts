/**
 * Amazon Bedrock Nova Sonic voice session — audio relay via bridge WebSocket.
 *
 * OpenAI uses browser WebRTC directly; Bedrock uses bridge-held AWS credentials
 * and InvokeModelWithBidirectionalStream on the server.
 */

import { unlockAudioContext } from './audio.js';
import type { SessionCallbacks } from './webrtc.js';
import {
  DEFAULT_WAKE_WORDS,
  isStartPhrase,
  isStopPhrase,
  type WakeWords,
} from './wake-words.js';

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

export class BedrockVoiceSession {
  private ws: WebSocket | null = null;
  private micStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private playbackCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private closed = false;
  private wakeWords: WakeWords = DEFAULT_WAKE_WORDS;
  private _serverDeactivated = false;
  /** Drop mic uplink while assistant audio is playing (prevents TTS echo loops). */
  private serverSpeaking = false;
  private playbackEndTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly cb: SessionCallbacks,
  ) {}

  async start(): Promise<void> {
    this.cb.onState('connecting');
    const mint = await this.mintToken();
    this.wakeWords = mint.wakeWords ?? DEFAULT_WAKE_WORDS;

    await unlockAudioContext();
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.playbackCtx = new AudioContext({ sampleRate: OUTPUT_RATE });

    const wsUrl = `${this.bridgeBase.replace(/^http/, 'ws')}/ws/voice`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            type: 'auth',
            token: this.appToken,
            sessionId: mint.sessionId,
          }),
        );
      });
      ws.addEventListener('message', (ev) => this.handleMessage(ev.data as string, resolve));
      ws.addEventListener('error', () => reject(new Error('Bedrock voice WebSocket error')));
      ws.addEventListener('close', () => {
        if (!this.closed) this.cb.onClosed();
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
    if (this.playbackEndTimer) clearTimeout(this.playbackEndTimer);
    this.playbackEndTimer = null;
    void this.audioCtx?.close();
    this.audioCtx = null;
    void this.playbackCtx?.close();
    this.playbackCtx = null;
  }

  injectNarration(_text: string): void {
    // Nova Sonic narration injection via bridge control WS — future hook.
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

  private handleMessage(raw: string, onConnected: () => void): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      case 'connected':
        this.cb.onState('connected');
        onConnected();
        break;
      case 'user_transcript':
        if (typeof msg['text'] === 'string') {
          const text = msg['text'];
          this.cb.onUserTranscript(text);
          if (isStartPhrase(text, this.wakeWords.start)) {
            this.cb.onActivated?.(this.wakeWords.start);
          }
          if (isStopPhrase(text, this.wakeWords.stop)) {
            // Server also emits deactivated — avoid duplicate handling.
            if (!this._serverDeactivated) {
              this.cb.onDeactivated?.(this.wakeWords.stop);
            }
            this._serverDeactivated = false;
          }
        }
        break;
      case 'assistant_transcript':
        if (typeof msg['text'] === 'string') this.cb.onAssistantTranscript(msg['text']);
        break;
      case 'audio_out':
        if (typeof msg['content'] === 'string') this.playPcmBase64(msg['content']);
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
        if (typeof msg['value'] === 'boolean') this.cb.onWorking(msg['value']);
        break;
      case 'deactivated':
        this._serverDeactivated = true;
        this.cb.onDeactivated?.(
          typeof msg['phrase'] === 'string' ? msg['phrase'] : this.wakeWords.stop,
        );
        break;
      case 'error':
        this.cb.onState('error');
        break;
    }
  }

  private startMicCapture(): void {
    if (!this.micStream) return;
    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.micStream);
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (ev) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.isMicInputBlocked()) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16k(input, this.audioCtx!.sampleRate);
      const b64 = pcm16ToBase64(pcm16);
      this.ws.send(JSON.stringify({ type: 'audio', content: b64 }));
    };
    source.connect(this.processor);
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
    src.connect(this.playbackCtx.destination);
    const start = Math.max(this.playbackCtx.currentTime, this.nextPlayTime);
    src.start(start);
    this.nextPlayTime = start + buffer.duration;
    this.serverSpeaking = true;
    this.cb.onSpeaking(true);
    this.schedulePlaybackEndCheck();
  }

  /** Block mic while server TTS is active or local playback queue has not drained. */
  private isMicInputBlocked(): boolean {
    if (this.serverSpeaking) return true;
    if (!this.playbackCtx) return false;
    return this.nextPlayTime > this.playbackCtx.currentTime + 0.15;
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
