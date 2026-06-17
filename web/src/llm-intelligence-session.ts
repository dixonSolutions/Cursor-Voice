/**
 * llm_intelligence voice session — WebKit STT/TTS with Amazon Polly/Transcribe fallback.
 *
 * Vosk (offline) gates wake and end phrases, cuts the mic stream, and triggers STT.
 * STT only runs during an utterance and transcribes once — never used for phrase detection.
 */

import {
  captureMicStream,
  createMicProcessingChain,
  getSharedAudioContext,
  unlockAudioContext,
  connectSilentSink,
  type MicProcessingChain,
} from './audio.js';
import { getVoiceAudioMeter } from './voice-audio-meter.js';
import type { SessionCallbacks } from './webrtc.js';
import { type TurnSubmit, type WakeWords } from './wake-words.js';
import { stopAllTts } from './tts-fallback.js';
import { WebkitSttSession } from './webkit-stt.js';
import { AmazonSttSession } from './amazon-stt.js';
import { speakAmazonPolly, stopAmazonTts } from './amazon-tts.js';
import {
  describeAudioBackends,
  type IntelligenceAudioConfig,
  type SttBackend,
  type TtsBackend,
} from './intelligence-audio.js';
import type { SttGate } from './stt-gate.js';
import { isCrossOriginIsolated } from './cross-origin-isolation.js';
import { VoskGrammarSpotter } from './vosk-wake-word.js';
import { TurnSubmitBuffer } from './turn-submit-buffer.js';

export interface IntelligenceAuthOk {
  sessionKey: string;
  workflow: string;
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  model: string;
  audio?: IntelligenceAudioConfig;
}

type SttSession = WebkitSttSession | AmazonSttSession;

export class LlmIntelligenceSession {
  private ws: WebSocket | null = null;
  private stt: SttSession | null = null;
  private closed = false;
  private wakeWords: WakeWords = { start: '', end: 'send' };
  private turnSubmit: TurnSubmit = { silenceMs: 1500 };
  private voiceActivated = false;
  /** True while STT is buffering audio between Vosk wake and end/silence cut. */
  private capturingUtterance = false;
  private orchestratorBusy = false;
  private ttsSpeaking = false;
  private wsConnected = false;
  private audioConfig: IntelligenceAudioConfig = {
    preferWebkit: true,
    amazonAvailable: false,
    sttFallback: null,
    ttsFallback: null,
  };
  private sttBackend: SttBackend = 'text_only';
  private ttsBackend: TtsBackend = 'none';
  private meterMicChain: MicProcessingChain | null = null;
  private startSpotter: VoskGrammarSpotter | null = null;
  private endSpotter: VoskGrammarSpotter | null = null;
  private turnBuffer: TurnSubmitBuffer | null = null;
  private pendingTurn = false;
  private endPhrasePending = false;
  private endSubmitTimer = 0;
  /** True only between wake activation and turn submit — end Vosk must not run before this. */
  private listeningForEndPhrase = false;
  private micMuted = false;
  private sharedMicStream: MediaStream | null = null;
  private ownsSharedMic = false;
  private readonly micTracks = new Set<MediaStreamTrack>();

  private readonly sttGate: SttGate = {
    isCapturing: () => this.capturingUtterance || this.endPhrasePending,
    /** Mic frozen via freezeCapture/endUtteranceCapture — not endPhrasePending (that blocks transcribe). */
    isPaused: () =>
      this.orchestratorBusy || this.ttsSpeaking || this.micMuted || this.pendingTurn,
  };

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly cb: SessionCallbacks,
  ) {}

  getAudioBackends(): { stt: SttBackend; tts: TtsBackend } {
    return { stt: this.sttBackend, tts: this.ttsBackend };
  }

  isVoiceActivated(): boolean {
    return this.voiceActivated;
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    for (const t of this.micTracks) t.enabled = !muted;
    if (muted) {
      this.startSpotter?.pause();
      if (this.listeningForEndPhrase) this.endSpotter?.pause();
    } else {
      this.startSpotter?.resume();
      if (this.listeningForEndPhrase) this.endSpotter?.resume();
    }
    if (this.stt instanceof AmazonSttSession) {
      this.stt.setMicEnabled(!muted);
    }
    this.syncCapture();
  }

  private registerMicStream(stream: MediaStream | null | undefined): void {
    stream?.getAudioTracks().forEach((t) => this.micTracks.add(t));
  }

  async start(): Promise<void> {
    this.cb.onState('connecting');
    await unlockAudioContext();

    const wsUrl = `${this.bridgeBase.replace(/^http/, 'ws')}/ws/intelligence`;
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
        ws.send(JSON.stringify({ type: 'auth', token: this.appToken }));
      });

      ws.addEventListener('message', (ev) => {
        this.handleMessage(ev.data as string, {
          onAuthOk: () => finish(resolve),
          onError: (message) => finish(() => reject(new Error(message))),
        });
      });

      ws.addEventListener('error', () =>
        finish(() => reject(new Error('Intelligence WebSocket error'))),
      );

      ws.addEventListener('close', (ev) => {
        if (!this.closed && this.wsConnected) {
          this.cb.onClosed?.('Intelligence WebSocket disconnected');
        }
        finish(() =>
          reject(new Error(ev.reason?.trim() || `Intelligence WebSocket closed (${ev.code})`)),
        );
      });
    });

    const backends = describeAudioBackends(this.audioConfig);
    this.sttBackend = backends.stt;
    this.ttsBackend = backends.tts;
    this.wsConnected = true;

    if (this.sttBackend !== 'text_only') {
      await this.startWakeWordPhase();
      await this.ensureSttPipeline();
    } else {
      await this.startWakeWordPhase();
    }

    this.cb.onState('connected');
  }

  close(): void {
    this.closed = true;
    this.wsConnected = false;
    this.endUtteranceCapture(true);
    this.stt?.stop();
    this.stt = null;
    this.startSpotter?.dispose();
    this.startSpotter = null;
    this.endSpotter?.dispose();
    this.endSpotter = null;
    this.turnBuffer?.dispose();
    this.turnBuffer = null;
    this.pendingTurn = false;
    this.endPhrasePending = false;
    this.capturingUtterance = false;
    this.listeningForEndPhrase = false;
    this.clearEndSubmitTimer();
    this.meterMicChain?.dispose();
    this.meterMicChain = null;
    this.micTracks.clear();
    this.micMuted = false;
    if (this.ownsSharedMic) {
      this.sharedMicStream?.getTracks().forEach((t) => t.stop());
    }
    this.sharedMicStream = null;
    this.ownsSharedMic = false;
    stopAllTts();
    stopAmazonTts();
    this.ws?.close();
    this.ws = null;
  }

  injectNarration(text: string): void {
    void this.playSpeak(text);
    this.cb.onAssistantTranscript(text);
  }

  /** Typed message — works even before wake phrase (skips wake gate). */
  sendTextTurn(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.closed || this.orchestratorBusy) return;
    if (!this.wsConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.cb.onSttError?.('Not connected — tap the orb to start a session.');
      return;
    }
    if (!this.voiceActivated) {
      this.voiceActivated = true;
      this.cb.onActivated?.('(typed input)');
    }
    this.cb.onUserTranscript(trimmed);
    this.sendUserTurn(trimmed);
  }

  private async ensureSharedMic(): Promise<MediaStream> {
    if (this.sharedMicStream) return this.sharedMicStream;
    this.sharedMicStream = await captureMicStream();
    this.ownsSharedMic = true;
    this.registerMicStream(this.sharedMicStream);
    return this.sharedMicStream;
  }

  private async attachMicMeter(stream?: MediaStream): Promise<void> {
    try {
      const mic = stream ?? (await this.ensureSharedMic());
      const ctx = getSharedAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      this.meterMicChain = createMicProcessingChain(mic, { highPassHz: 120 });
      const tap = getVoiceAudioMeter().tapMic(ctx, this.meterMicChain.output);
      connectSilentSink(ctx, tap);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cb.onSttError?.(`Microphone unavailable: ${message}`);
    }
  }

  /** Idle phase — Vosk only; no STT pipeline (no Transcribe cost). */
  private async startWakeWordPhase(): Promise<void> {
    const mic = await this.ensureSharedMic();
    await this.attachMicMeter(mic);

    if (!isCrossOriginIsolated()) {
      this.cb.onSttError?.(
        'Wake/end phrase detection needs COOP/COEP — open http://localhost:4200 (ng serve) or the bridge URL. Typed input still works.',
      );
      return;
    }

    await this.armStartSpotter();
  }

  private async armStartSpotter(): Promise<void> {
    const start = this.wakeWords.start.trim();
    if (!start) {
      this.cb.onSttError?.('No wake phrase configured — set wakeWords.start on the Voice tab.');
      return;
    }
    if (!isCrossOriginIsolated() || this.closed) return;

    this.stopStartSpotter();
    try {
      this.startSpotter = new VoskGrammarSpotter({
        onMatch: () => void this.onVoskStartDetected(),
        onError: (message) => {
          console.warn('[vosk-start]', message);
          this.cb.onSttError?.(`Wake phrase spotter: ${message}`);
        },
      });
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      await this.startSpotter.start(start, {
        mediaStream: mic,
        matchPartial: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[vosk-start]', message);
      this.startSpotter?.dispose();
      this.startSpotter = null;
      this.cb.onSttError?.(`Wake phrase spotter failed: ${message}`);
    }
  }

  /** After end phrase or turn complete — Vosk wake only, orb back to inactive/red. */
  private async returnToWakeListen(): Promise<void> {
    if (this.closed) return;
    this.voiceActivated = false;
    this.capturingUtterance = false;
    this.listeningForEndPhrase = false;
    this.stopEndSpotter();
    if (this.stt instanceof WebkitSttSession) {
      this.stt.pause();
    }
    this.cb.onDeactivated?.();
    await this.armStartSpotter();
  }

  private async onVoskStartDetected(): Promise<void> {
    if (this.closed || this.voiceActivated) return;
    this.stopStartSpotter();
    this.voiceActivated = true;
    this.cb.onActivated?.(this.wakeWords.start);
    await this.enterCapturePhase();
  }

  private stopStartSpotter(): void {
    this.startSpotter?.dispose();
    this.startSpotter = null;
  }

  private stopEndSpotter(): void {
    this.endSpotter?.dispose();
    this.endSpotter = null;
    this.listeningForEndPhrase = false;
  }

  private exitCapturePhase(): void {
    this.listeningForEndPhrase = false;
    this.stopEndSpotter();
    this.clearEndSubmitTimer();
    this.endPhrasePending = false;
    this.endUtteranceCapture(true);
  }

  /** Vosk wake heard — open STT stream, arm end-phrase Vosk. */
  private async enterCapturePhase(): Promise<void> {
    this.resetTurnBuffer();
    await this.beginUtteranceCapture();
    if (this.closed || !this.voiceActivated) return;
    await this.armEndPhraseSpotter();
  }

  private resetTurnBuffer(): void {
    this.turnBuffer?.dispose();
    this.turnBuffer = new TurnSubmitBuffer({
      silenceMs: this.turnSubmit.silenceMs,
      endPhrase: this.wakeWords.end,
      onSubmit: (text, reason) => this.flushTurn(text, reason),
    });
  }

  private async ensureMicMeter(): Promise<void> {
    if (this.meterMicChain) return;
    await this.attachMicMeter(this.sharedMicStream ?? undefined);
  }

  /** Create STT hardware once (mic tap); utterances use beginUtteranceCapture(). */
  private async ensureSttPipeline(): Promise<void> {
    await this.ensureMicMeter();
    if (this.stt) return;

    if (this.sttBackend === 'webkit') {
      this.stt = new WebkitSttSession('en-US', this.sttGate, {
        onFinal: (text) => this.onUserText(text),
        onError: (message) => {
          console.warn('[webkit-stt]', message);
          this.cb.onSttError?.(message);
        },
        onEnd: () => {
          if (this.closed || this.sttGate.isPaused() || !this.capturingUtterance) return;
          if (this.stt instanceof WebkitSttSession) {
            window.setTimeout(() => {
              if (this.capturingUtterance && !this.sttGate.isPaused()) {
                this.stt?.start();
              }
            }, 250);
          }
        },
      });
      return;
    }

    if (this.sttBackend === 'amazon_transcribe') {
      const amazon = new AmazonSttSession(this.bridgeBase, this.appToken, this.sttGate, {
        onFinal: (text) => this.onUserText(text),
        onError: (message) => {
          console.warn('[amazon-stt]', message);
          this.cb.onSttError?.(message);
          if (this.endPhrasePending) {
            this.endPhrasePending = false;
            this.clearEndSubmitTimer();
            if (this.stt instanceof AmazonSttSession) this.stt.endCapture();
            void this.returnToWakeListen();
          }
        },
      });
      this.stt = amazon;
      await amazon.start(this.sharedMicStream ?? undefined);
    }
  }

  /** Vosk cut-in: start buffering audio for one utterance. */
  private async beginUtteranceCapture(): Promise<void> {
    if (!this.voiceActivated || this.closed || this.pendingTurn) return;
    await this.ensureSttPipeline();
    this.capturingUtterance = true;
    const silenceFlush = this.turnSubmit.silenceMs > 0;
    if (this.stt instanceof AmazonSttSession) {
      this.stt.beginCapture({ silenceFlush });
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.start();
    }
  }

  /** Vosk cut-out: stop buffering (optionally discard buffered audio). */
  private endUtteranceCapture(discard = false): void {
    this.capturingUtterance = false;
    if (this.stt instanceof AmazonSttSession) {
      if (discard) this.stt.endCapture();
      else this.stt.freezeCapture();
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.pause();
    }
  }

  private async armEndPhraseSpotter(): Promise<void> {
    const end = this.wakeWords.end.trim();
    if (!end) {
      this.cb.onSttError?.(
        'No end phrase configured — set wakeWords.end on the Voice tab or use silence submit.',
      );
      return;
    }
    if (!isCrossOriginIsolated()) {
      this.cb.onSttError?.('End phrase Vosk needs COOP/COEP — silence submit still works.');
      return;
    }
    if (!this.voiceActivated) return;

    this.stopEndSpotter();
    this.endSpotter = new VoskGrammarSpotter({
      onMatch: () => this.onEndPhraseHeard(),
      onError: (message) => {
        console.warn('[vosk-end]', message);
        this.cb.onSttError?.(`End phrase spotter: ${message}`);
      },
    });

    try {
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      const voskMic = cloneMicForVosk(mic);
      await this.endSpotter.start(end, {
        mediaStream: voskMic,
        matchPartial: true,
      });
      this.listeningForEndPhrase = true;
      this.cb.onEndPhraseArmed?.(end);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[vosk-end]', err);
      this.stopEndSpotter();
      this.cb.onSttError?.(`End phrase spotter failed: ${message}`);
    }
  }

  /** Vosk end phrase — freeze mic, transcribe once, return to wake listen immediately. */
  private onEndPhraseHeard(): void {
    if (this.closed || !this.listeningForEndPhrase || !this.voiceActivated || this.pendingTurn) {
      return;
    }
    this.endPhrasePending = true;
    this.listeningForEndPhrase = false;
    this.stopEndSpotter();
    this.cb.onEndPhraseDetected?.(this.wakeWords.end);
    this.endUtteranceCapture(false);
    this.flushSttNow();
    void this.returnToWakeListen();
    this.scheduleEndWordSubmit();
  }

  private flushSttNow(): void {
    if (this.stt instanceof AmazonSttSession) {
      this.stt.flushNow();
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.flushNow();
    }
  }

  private enqueueSpeech(text: string): void {
    if (this.pendingTurn) return;
    const trimmed = text.trim();
    if (!trimmed || !this.turnBuffer) return;
    this.cb.onUserTranscript(trimmed);
    this.turnBuffer.append(trimmed);
    if (this.endPhrasePending && this.turnBuffer.submitNow('end_word')) {
      this.endPhrasePending = false;
      this.clearEndSubmitTimer();
    }
  }

  private scheduleEndWordSubmit(): void {
    this.clearEndSubmitTimer();
    const maxAttempts = 75;
    const retryMs = 400;
    const trySubmit = (attempt: number): void => {
      if (this.closed || this.pendingTurn) return;
      if (this.turnBuffer?.submitNow('end_word')) {
        this.endPhrasePending = false;
        return;
      }
      const buffered = this.turnBuffer?.text() ?? '';
      if (attempt < maxAttempts) {
        this.endSubmitTimer = window.setTimeout(() => trySubmit(attempt + 1), retryMs);
        return;
      }
      this.endPhrasePending = false;
      if (this.stt instanceof AmazonSttSession) this.stt.endCapture();
      if (buffered) {
        this.cb.onSttError?.(
          `Could not send — transcript was only "${buffered.slice(0, 40)}". Say your request after "${this.wakeWords.start}", then "${this.wakeWords.end}".`,
        );
      } else {
        this.cb.onSttError?.(
          'End phrase heard but transcription failed — check Amazon Transcribe config and speak clearly after the wake phrase.',
        );
      }
      void this.returnToWakeListen();
    };
    this.endSubmitTimer = window.setTimeout(() => trySubmit(0), 150);
  }

  private clearEndSubmitTimer(): void {
    if (this.endSubmitTimer) {
      window.clearTimeout(this.endSubmitTimer);
      this.endSubmitTimer = 0;
    }
  }

  private flushTurn(text: string, reason: 'silence' | 'end_word'): void {
    if (this.closed || this.orchestratorBusy || this.pendingTurn) return;
    this.exitCapturePhase();
    this.pendingTurn = true;
    this.endPhrasePending = false;
    this.clearEndSubmitTimer();
    if (this.stt instanceof AmazonSttSession) this.stt.endCapture();
    this.sendUserTurn(text);
    this.cb.onTurnSubmitted?.(reason);
    console.debug('[turn-submit]', reason, text.slice(0, 80));
    void this.returnToWakeListen();
  }

  /** STT transcript for the current utterance only (Vosk already gated wake/end). */
  private onUserText(text: string): void {
    if (this.closed || this.pendingTurn) return;
    if (!this.capturingUtterance && !this.endPhrasePending) return;
    if (this.stt instanceof AmazonSttSession && this.capturingUtterance) {
      this.endUtteranceCapture(false);
    }
    this.enqueueSpeech(text);
  }

  private sendUserTurn(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'user_turn', text }));
  }

  private syncCapture(): void {
    if (this.sttGate.isPaused()) {
      this.stt instanceof WebkitSttSession ? this.stt.pause() : undefined;
      if (this.listeningForEndPhrase) this.endSpotter?.pause();
    } else {
      if (this.capturingUtterance) {
        this.stt instanceof WebkitSttSession ? this.stt.resume() : undefined;
      }
      if (this.listeningForEndPhrase) this.endSpotter?.resume();
    }
  }

  private handleMessage(
    raw: string,
    hooks: { onAuthOk: () => void; onError: (message: string) => void },
  ): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      case 'auth_ok': {
        const wake = msg['wakeWords'] as WakeWords | undefined;
        this.wakeWords = wake ?? { start: '', end: 'send' };
        const submit = msg['turnSubmit'] as TurnSubmit | undefined;
        this.turnSubmit = submit ?? { silenceMs: 1500 };
        if (msg['audio'] && typeof msg['audio'] === 'object') {
          this.audioConfig = msg['audio'] as IntelligenceAudioConfig;
        }
        hooks.onAuthOk();
        break;
      }

      case 'speak': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text) void this.playSpeak(text);
        break;
      }

      case 'assistant_transcript': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text) this.cb.onAssistantTranscript(text);
        break;
      }

      case 'thinking':
        this.orchestratorBusy = Boolean(msg['value']);
        this.cb.onWorking(this.orchestratorBusy);
        this.syncCapture();
        break;

      case 'tool_activity': {
        const tool = String(msg['tool'] ?? '');
        const phase = msg['phase'] as 'start' | 'done' | 'error' | undefined;
        const label = String(msg['label'] ?? tool);
        if (phase && tool) {
          this.cb.onToolActivity?.({
            tool,
            phase,
            label,
            detail: typeof msg['detail'] === 'string' ? msg['detail'] : undefined,
          });
        }
        break;
      }

      case 'turn_complete':
        this.orchestratorBusy = false;
        this.pendingTurn = false;
        this.endPhrasePending = false;
        this.turnBuffer?.dispose();
        this.turnBuffer = null;
        this.cb.onWorking(false);
        this.cb.onTurnComplete?.();
        void this.returnToWakeListen();
        break;

      case 'error': {
        const message = String(msg['message'] ?? 'Intelligence session error');
        if (this.wsConnected) {
          this.orchestratorBusy = false;
          this.pendingTurn = false;
          this.cb.onWorking(false);
          this.syncCapture();
          this.cb.onTurnError?.(message);
          break;
        }
        hooks.onError(message);
        break;
      }

      default:
        break;
    }
  }

  private async playSpeak(text: string): Promise<void> {
    this.ttsSpeaking = true;
    this.cb.onSpeaking(true);
    this.notifySpeakingState(true);
    this.syncCapture();

    try {
      if (this.ttsBackend === 'webkit') {
        await this.playWebkit(text);
      } else if (this.ttsBackend === 'amazon_polly') {
        await speakAmazonPolly(text, this.bridgeBase, this.appToken);
      }
    } catch (err) {
      console.warn('[tts]', err);
      if (this.ttsBackend === 'webkit' && this.audioConfig.amazonAvailable) {
        try {
          await speakAmazonPolly(text, this.bridgeBase, this.appToken);
        } catch (pollyErr) {
          console.warn('[tts polly fallback]', pollyErr);
        }
      }
    } finally {
      this.ttsSpeaking = false;
      this.cb.onSpeaking(false);
      this.notifySpeakingState(false);
      this.syncCapture();
    }
  }

  private playWebkit(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        resolve();
        return;
      }
      stopAllTts();
      const clean = text.replace(/^\[Speak to user\]:\s*/i, '').trim();
      if (!clean) {
        resolve();
        return;
      }
      const utter = new SpeechSynthesisUtterance(clean);
      utter.rate = 1.02;
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    });
  }

  private notifySpeakingState(speaking: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'speaking', value: speaking }));
  }
}

/** Separate mic tap for Vosk so STT ScriptProcessors do not starve the spotter. */
function cloneMicForVosk(mic: MediaStream): MediaStream {
  const track = mic.getAudioTracks()[0];
  if (track && typeof track.clone === 'function') {
    return new MediaStream([track.clone()]);
  }
  return mic;
}
