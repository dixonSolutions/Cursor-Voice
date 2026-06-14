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
 * "cursor end" / "cursor stop":
 *   Detected in the user's speech transcript → onClosed() callback.
 *
 * ## GA API notes (not the beta schema)
 * - SDP exchange: POST https://api.openai.com/v1/realtime?model=<model>
 *   Authorization: Bearer <ephemeral-token>, Content-Type: application/sdp
 * - Do NOT send OpenAI-Beta: realtime=v1
 * - Event names: response.output_audio.delta / .done, response.done (function calls)
 */

import { unlockAudioContext, createAudioElement } from './audio.js';

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
  /** Session closed — e.g. PTT tap or "cursor end" / "cursor stop" detected. */
  onClosed(reason?: string): void;
  /**
   * Relay a function call to the bridge control WebSocket.
   * Returns the tool result, or throws on tool error / WS disconnect.
   * Implemented in main.ts; wraps the WS send + pending-call map.
   */
  relayToolCall(callId: string, name: string, args: unknown): Promise<unknown>;
}

// ── Internal types ─────────────────────────────────────────────────────────

interface TokenPayload {
  token: string;
  model: string;
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
  private isClosed = false;

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
      const { token, model } = await this.mintToken();

      // 2. Unlock AudioContext inside the gesture stack (iOS autoplay policy)
      await unlockAudioContext();

      // 3. Capture microphone
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      // 4. Create peer connection
      this.pc = new RTCPeerConnection();

      // 5. Send mic audio to provider
      for (const track of this.micStream.getTracks()) {
        this.pc.addTrack(track, this.micStream);
      }

      // 6. Receive provider TTS audio → attach to <audio>
      this.audioEl = createAudioElement();
      this.pc.ontrack = (ev: RTCTrackEvent) => {
        if (this.audioEl && ev.streams[0]) {
          this.audioEl.srcObject = ev.streams[0];
          // play() should resolve immediately — user gesture already consumed
          void this.audioEl.play().catch(() => {
            // Autoplay blocked despite unlock; non-fatal — audio will resume
          });
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
      throw new Error(`Token mint failed (${res.status} ${res.statusText})`);
    }
    return res.json() as Promise<TokenPayload>;
  }

  /**
   * POST the SDP offer to the provider and get the SDP answer.
   * GA API: POST /v1/realtime?model=<model>
   * No OpenAI-Beta header (GA, not beta).
   */
  private async exchangeSdp(token: string, model: string, offerSdp: string): Promise<string> {
    const url = `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sdp',
        // GA: do NOT include OpenAI-Beta: realtime=v1
      },
      body: offerSdp,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`SDP exchange failed (${res.status}): ${text}`);
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
        // Session live — state already set to 'connected' after SDP exchange
        break;

      // ── TTS audio (track speaking state for narrator cadence) ──────────
      case 'response.output_audio.delta':
        this.cb.onSpeaking(true);
        break;

      case 'response.output_audio.done':
        this.cb.onSpeaking(false);
        break;

      // ── User speech transcript ─────────────────────────────────────────
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event['transcript'] as string | undefined)?.trim() ?? '';
        if (text) {
          this.cb.onUserTranscript(text);
          // Detect stop verbs — the system prompt also handles these, but
          // detecting client-side gives instant mic release without a round-trip.
          if (/\bcursor\s+(end|stop)\b/i.test(text) || /\bthat'?s\s+all\b/i.test(text)) {
            this.cb.onClosed('cursor end');
          }
        }
        break;
      }

      // ── Assistant transcript ───────────────────────────────────────────
      case 'response.output_audio_transcript.done': {
        const text = (event['transcript'] as string | undefined)?.trim() ?? '';
        if (text) {
          this.cb.onAssistantTranscript(text);
        }
        this.cb.onSpeaking(false);
        break;
      }

      // ── Response complete — function calls surface here in GA ──────────
      case 'response.done': {
        const response = event['response'] as Record<string, unknown> | undefined;
        const output = (response?.['output'] as unknown[]) ?? [];

        const calls = output.filter(
          (item): item is FunctionCallItem =>
            (item as Record<string, unknown>)['type'] === 'function_call',
        );

        if (calls.length > 0) {
          this.cb.onWorking(true);
          // Execute sequentially — voice model rarely issues parallel calls
          void this.executeToolCalls(calls);
        } else {
          // Response without tool calls (conversational turn)
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
