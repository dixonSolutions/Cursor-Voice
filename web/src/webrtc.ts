/**
 * WebRTC voice session for Cursor Voice PWA.
 *
 * Establishes a WebRTC peer connection to the voice provider (OpenAI
 * Realtime GA) using an ephemeral token minted by the bridge.
 *
 * ## Architecture (docs/06-voice-audio-webrtc.md)
 *
 * Audio path:
 *   Mic → RTCPeerConnection → provider (STT + reasoning + TTS) → <audio>
 *   WebRTC handles Opus encoding, echo cancellation, and playback natively.
 *
 * Tool-call relay path:
 *   Provider → function_call (data channel)
 *   → relayToolCall callback → bridge control WS
 *   → tool executed on bridge → WS result
 *   → function_call_output (data channel)
 *   → provider speaks summary
 *
 * Narration injection:
 *   Bridge WS sends { type:"narration", text }
 *   → injectNarration() → conversation.item.create (data channel)
 *   → provider TTS plays it for Dad
 *
 * Activation phrase (from config):
 *   Start phrase → onActivated (begin listening for commands).
 *   End session entirely → tap the orb while session is open.
 *
 * ## GA API notes (not the beta schema)
 * - Token mint: POST https://api.openai.com/v1/realtime/client_secrets
 * - SDP exchange: POST https://api.openai.com/v1/realtime/calls
 *   Authorization: Bearer <ephemeral-token>, Content-Type: application/sdp
 * - Do NOT send OpenAI-Beta: realtime=v1
 * - Event names: response.output_audio.delta / .done, response.done (function calls)
 */

import {
  unlockAudioContext,
  createAudioElement,
  captureMicStream,
  createFilteredMicStream,
  getSharedAudioContext,
} from './audio.js';
import { getVoiceAudioMeter } from './voice-audio-meter.js';
import {
  OPENAI_REALTIME_CALLS_URL,
  OPENAI_ASSISTANT_TRANSCRIPT,
  OPENAI_SPEAKING_END,
  OPENAI_SPEAKING_START,
  OPENAI_USER_TRANSCRIPT,
  extractTranscript,
  readHttpError,
} from './openai-realtime.js';
import {
  isStartPhrase,
  type WakeWords,
} from './wake-words.js';

// ── Callbacks ─────────────────────────────────────────────────────────────

export interface SessionCallbacks {
  /** Peer connection / data channel state changed. */
  onState(state: 'connecting' | 'connected' | 'error'): void;
  /** User speech transcribed (from VAD + Whisper). */
  onUserTranscript(text: string): void;
  /** Provider assistant transcript turn completed. */
  onAssistantTranscript(text: string): void;
  /** TTS audio started (true) or ended (false) — used to gate narration cadence. */
  onSpeaking(speaking: boolean): void;
  /** A tool call is in-flight (true = show working state; false = done). */
  onWorking(active: boolean): void;
  /** Session ended — PTT tap to hang up or WebSocket closed. */
  onClosed(reason?: string): void;
  /** Start wake phrase heard — utterance capture begins. */
  onActivated?(phrase: string): void;
  /** Returned to wake-phrase listen after end phrase or turn complete (orb red). */
  onDeactivated?(): void;
  /** Heard speech before wake phrase matched — use for user feedback. */
  onWakeRejected?(heard: string, expectedWake: string): void;
  /** STT or mic error — surface to the user. */
  onSttError?(message: string): void;
  /** Orchestrator / Bedrock turn failed after session is connected. */
  onTurnError?(message: string): void;
  /** Cursor finished a voice turn (done() / turn_complete). */
  onTurnComplete?(): void;
  /** Vosk is listening for the end/submit phrase (after wake, during STT). */
  onEndPhraseArmed?(phrase: string): void;
  /** Vosk heard the configured end/submit phrase. */
  onEndPhraseDetected?(phrase: string): void;
  /** Turn flushed to bridge (end phrase or silence). */
  onTurnSubmitted?(reason: 'silence' | 'end_word'): void;
  /**
   * Relay a function call to the bridge control WebSocket.
   * Returns the tool result, or throws on tool error / WS disconnect.
   * Implemented in main.ts; wraps the WS send + pending-call map.
   */
  relayToolCall(callId: string, name: string, args: unknown): Promise<unknown>;
  /** Latest tool call visibility (Bedrock server path or WebRTC relay). */
  onToolActivity?(event: {
    tool: string;
    phase: 'start' | 'done' | 'error';
    label: string;
    detail?: string;
  }): void;
}

// ── Internal types ─────────────────────────────────────────────────────────

interface TokenPayload {
  token: string;
  model: string;
  wakeWords: WakeWords;
}

interface ProviderEvent {
  type: string;
  [key: string]: unknown;
}

interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

// ── Voice session ─────────────────────────────────────────────────────────

export class WebRTCVoiceSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private micStream: MediaStream | null = null;
  private micFilterDispose: (() => void) | null = null;
  private isClosed = false;
  private wakeWords: WakeWords = { start: '', end: 'send' };

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly cb: SessionCallbacks,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Establish the WebRTC session.
   * Must be called inside a user-gesture handler (PTT tap) so that
   * getUserMedia and AudioContext.resume() are permitted on iOS.
   */
  async start(): Promise<void> {
    try {
      this.cb.onState('connecting');

      // 1. Mint ephemeral token from bridge — API key never reaches the phone
      const { token, model, wakeWords } = await this.mintToken();
      this.wakeWords = wakeWords;

      // 2. Unlock AudioContext inside the gesture stack (iOS autoplay policy)
      await unlockAudioContext();

      // 3. Capture microphone (browser NS + high-pass + noise gate for WebRTC uplink)
      this.micStream = await captureMicStream();
      const filtered = createFilteredMicStream(this.micStream);
      this.micFilterDispose = filtered.dispose;

      const meterCtx = getSharedAudioContext();
      const micMonitor = meterCtx.createMediaStreamSource(this.micStream);
      const micTap = getVoiceAudioMeter().tapMic(meterCtx, micMonitor);
      const micSilent = meterCtx.createGain();
      micSilent.gain.value = 0;
      micTap.connect(micSilent);
      micSilent.connect(meterCtx.destination);

      // 4. Create peer connection
      this.pc = new RTCPeerConnection();

      // 5. Send filtered mic audio to provider
      for (const track of filtered.stream.getTracks()) {
        this.pc.addTrack(track, filtered.stream);
      }

      // 6. Receive provider TTS audio → attach to <audio>
      this.audioEl = createAudioElement();
      this.pc.ontrack = (ev: RTCTrackEvent) => {
        if (this.audioEl && ev.streams[0]) {
          this.audioEl.srcObject = ev.streams[0];
          void this.audioEl.play().catch(() => {
            // Autoplay blocked despite unlock; non-fatal — audio will resume
          });

          const remoteCtx = getSharedAudioContext();
          const remoteSource = remoteCtx.createMediaStreamSource(ev.streams[0]);
          const outTap = getVoiceAudioMeter().tapPlayback(remoteCtx, remoteSource);
          const outSilent = remoteCtx.createGain();
          outSilent.gain.value = 0;
          outTap.connect(outSilent);
          outSilent.connect(remoteCtx.destination);
        }
      };

      // 7. Data channel for provider events (function calls, transcripts…)
      this.dc = this.pc.createDataChannel('oai-events');
      this.dc.addEventListener('message', (ev: MessageEvent<string>) => {
        this.handleProviderEvent(ev.data);
      });

      // 8. Create SDP offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // 9. Exchange SDP with provider using the ephemeral token
      const answerSdp = await this.exchangeSdp(token, model, offer.sdp!);
      await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      this.cb.onState('connected');
    } catch (err) {
      if (!this.isClosed) {
        this.cb.onState('error');
        this.doClose();
      }
      throw err;
    }
  }

  /**
   * Inject a narration text into the provider session.
   * Called when the bridge sends { type:"narration", text } over the
   * control WS. The provider TTS's it so Dad hears progress updates.
   */
  injectNarration(text: string): void {
    // conversation.item.create sends an assistant message into the conversation
    this.sendToProvider({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    });
    // response.create triggers the provider to TTS the item
    this.sendToProvider({ type: 'response.create' });
  }

  /** Tear down the session and release all resources. */
  close(): void {
    this.doClose();
  }

  // ── Private ───────────────────────────────────────────────────────────

  private doClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const track of this.micStream?.getTracks() ?? []) {
      track.stop();
    }
    this.micStream = null;
    this.micFilterDispose?.();
    this.micFilterDispose = null;
    this.dc?.close();
    this.dc = null;
    this.pc?.close();
    this.pc = null;
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
  }

  private async mintToken(): Promise<TokenPayload> {
    const res = await fetch(`${this.bridgeBase}/api/realtime/token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`Token mint failed: ${await readHttpError(res)}`);
    }
    const data = (await res.json()) as TokenPayload;
    return {
      token: data.token,
      model: data.model,
      wakeWords: data.wakeWords,
    };
  }

  /**
   * POST the SDP offer to the provider and get the SDP answer.
   * GA API: POST /v1/realtime/calls (model is bound in the client secret).
   */
  private async exchangeSdp(token: string, _model: string, offerSdp: string): Promise<string> {
    const res = await fetch(OPENAI_REALTIME_CALLS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    });
    if (!res.ok) {
      throw new Error(`SDP exchange failed: ${await readHttpError(res)}`);
    }
    return res.text();
  }

  private sendToProvider(event: object): void {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify(event));
    }
  }

  // ── Provider event dispatch ───────────────────────────────────────────

  private handleProviderEvent(raw: string): void {
    let event: ProviderEvent;
    try {
      event = JSON.parse(raw) as ProviderEvent;
    } catch {
      return;
    }

    const t = event['type'] as string;

    switch (t) {
      case 'session.created':
        break;

      case 'response.done': {
        const response = event['response'] as Record<string, unknown> | undefined;
        const output = (response?.['output'] as unknown[]) ?? [];

        const calls = output.filter(
          (item): item is FunctionCallItem =>
            (item as Record<string, unknown>)['type'] === 'function_call',
        );

        if (calls.length > 0) {
          this.cb.onWorking(true);
          void this.executeToolCalls(calls);
        } else {
          this.cb.onWorking(false);
          this.cb.onSpeaking(false);
        }
        break;
      }

      case 'error': {
        const errObj = event['error'] as Record<string, unknown> | undefined;
        const msg = (errObj?.['message'] as string | undefined) ?? 'Provider error';
        console.error('[webrtc] provider error:', msg, errObj?.['code']);
        this.cb.onState('error');
        break;
      }

      default:
        if (OPENAI_SPEAKING_START.has(t)) {
          this.cb.onSpeaking(true);
          break;
        }
        if (OPENAI_SPEAKING_END.has(t)) {
          this.cb.onSpeaking(false);
          break;
        }
        if (OPENAI_USER_TRANSCRIPT.has(t)) {
          const text = extractTranscript(event);
          if (text) {
            this.cb.onUserTranscript(text);
            if (isStartPhrase(text, this.wakeWords.start)) {
              this.cb.onActivated?.(this.wakeWords.start);
            }
          }
          break;
        }
        if (OPENAI_ASSISTANT_TRANSCRIPT.has(t)) {
          const text = extractTranscript(event);
          if (text) this.cb.onAssistantTranscript(text);
          this.cb.onSpeaking(false);
        }
        break;
    }
  }

  /**
   * Execute function calls sequentially.
   *
   * Each call is relayed to the bridge via the authenticated control WS
   * (through the relayToolCall callback). The bridge validates args,
   * executes the tool, and returns the result. The phone is a relay —
   * it never executes tools itself.
   */
  private async executeToolCalls(calls: FunctionCallItem[]): Promise<void> {
    for (const call of calls) {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = {};
      }

      let output: string;
      try {
        const result = await this.cb.relayToolCall(call.call_id, call.name, args);
        output = JSON.stringify(result ?? {});
      } catch (err) {
        output = JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Return result to the provider data channel
      this.sendToProvider({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        },
      });
    }

    // Trigger provider to generate the next conversational response
    this.sendToProvider({ type: 'response.create' });
    this.cb.onWorking(false);
  }
}
