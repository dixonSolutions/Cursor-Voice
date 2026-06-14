import { Injectable, inject, signal } from '@angular/core';
import { WebRTCVoiceSession } from '../../webrtc.js';
import { AppStateService } from './app-state.service';
import { BridgeService } from './bridge.service';

export interface TranscriptEntry {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system' | 'error';
}

/** Max entries kept in the transcript log (Miller's Law). */
const MAX_ENTRIES = 50;
let _nextId = 0;

/**
 * Voice session service — wraps WebRTCVoiceSession lifecycle.
 *
 * Coordinates:
 *   - WebRTC session start / stop (PTT tap)
 *   - Transcript log (signal array updated on every event)
 *   - Speaking state → bridge narrator cadence gate
 *   - Tool-call relay → BridgeService.relayToolCall()
 *   - Narration injection into the open session
 *   - AppState transitions (listening ↔ working ↔ idle)
 */
@Injectable({ providedIn: 'root' })
export class VoiceSessionService {
  private readonly bridge = inject(BridgeService);
  private readonly appState = inject(AppStateService);

  private _session: WebRTCVoiceSession | null = null;

  readonly transcript = signal<TranscriptEntry[]>([]);

  // ── Session lifecycle ──────────────────────────────────────────────────

  async startSession(): Promise<void> {
    if (this._session) return; // already active

    this.appState.transitionTo('listening');
    this.addEntry('[Mic on — say "Cursor…" to begin a command]', 'system');

    const session = new WebRTCVoiceSession(
      this.bridge.bridgeBase,
      this.bridge.appToken,
      {
        onState: (s) => {
          if (s === 'error') {
            this.addEntry('Voice connection error — tap to retry', 'error');
            this.stopSession();
          }
        },
        onUserTranscript: (text) => {
          this.addEntry(`You: ${text}`, 'user');
        },
        onAssistantTranscript: (text) => {
          this.addEntry(`Cursor: ${text}`, 'assistant');
        },
        onSpeaking: (speaking) => {
          this.bridge.sendSpeakingState(speaking);
        },
        onWorking: (active) => {
          this.appState.transitionTo(active ? 'working' : 'listening');
        },
        onClosed: (reason) => {
          this.stopSession(reason);
        },
        relayToolCall: (callId, name, args) =>
          this.bridge.relayToolCall(callId, name, args),
      },
    );

    this._session = session;

    try {
      await session.start();
    } catch (err) {
      this.addEntry(`Could not start voice: ${String(err)}`, 'error');
      this.stopSession();
    }
  }

  stopSession(reason?: string): void {
    this._session?.close();
    this._session = null;
    this.bridge.sendSpeakingState(false);
    if (reason) {
      this.addEntry(`[${reason}]`, 'system');
    }
    this.appState.transitionTo('idle');
  }

  /** Forward a bridge narration event to the open WebRTC session. */
  injectNarration(text: string): void {
    this._session?.injectNarration(text);
  }

  // ── Transcript ────────────────────────────────────────────────────────

  addEntry(text: string, role: TranscriptEntry['role']): void {
    this.transcript.update((entries) => {
      const next = [...entries, { id: _nextId++, text, role }];
      // Trim to max (keep most recent)
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }
}
