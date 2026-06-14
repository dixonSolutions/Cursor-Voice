import { Injectable, inject, signal } from '@angular/core';
import { BedrockVoiceSession } from '../../bedrock-voice.js';
import { WebRTCVoiceSession, type SessionCallbacks } from '../../webrtc.js';
import { AppStateService } from './app-state.service';
import { BridgeService } from './bridge.service';
import { LogService } from './log.service';
import { ToastService } from './toast.service';
import { VoiceProvidersService } from './voice-providers.service';

export interface TranscriptEntry {
  id: number;
  text: string;
  role: 'user' | 'assistant';
}

const MAX_ENTRIES = 50;
let _nextId = 0;

type ActiveSession = WebRTCVoiceSession | BedrockVoiceSession;

@Injectable({ providedIn: 'root' })
export class VoiceSessionService {
  private readonly bridge = inject(BridgeService);
  private readonly appState = inject(AppStateService);
  private readonly toast = inject(ToastService);
  private readonly voiceProviders = inject(VoiceProvidersService);
  private readonly logs = inject(LogService);

  private _session: ActiveSession | null = null;
  private readonly _voiceActivated = signal(false);
  private readonly _jobRunning = signal(false);

  readonly transcript = signal<TranscriptEntry[]>([]);
  readonly conversationActive = signal(false);
  readonly sessionConnecting = signal(false);

  isVoiceActivated(): boolean {
    return this._voiceActivated();
  }

  notifyJobRunning(running: boolean): void {
    this._jobRunning.set(running);
    this.syncAppState();
  }

  async startSession(): Promise<void> {
    if (this._session || this.sessionConnecting()) return;

    this.sessionConnecting.set(true);
    this._voiceActivated.set(false);
    this._jobRunning.set(false);

    const callbacks = this.buildCallbacks();
    const transport = this.resolveTransport();

    const session =
      transport === 'bedrock_ws'
        ? new BedrockVoiceSession(this.bridge.bridgeBase, this.bridge.appToken, callbacks)
        : new WebRTCVoiceSession(this.bridge.bridgeBase, this.bridge.appToken, callbacks);

    this._session = session;

    try {
      await session.start();
      this.logs.append('info', 'voice', 'Voice session started — say wake phrase to activate');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logs.append('error', 'voice', 'Could not start voice', detail);
      this.toast.error('Could not start voice', detail);
      this.stopSession();
    } finally {
      this.sessionConnecting.set(false);
    }
  }

  stopSession(): void {
    this._session?.close();
    this._session = null;
    this.sessionConnecting.set(false);
    this._voiceActivated.set(false);
    this._jobRunning.set(false);
    this.bridge.sendSpeakingState(false);
    this.conversationActive.set(false);
    this.transcript.set([]);
    this.appState.transitionTo('idle');
  }

  injectNarration(text: string): void {
    if (!this.conversationActive()) return;
    this._session?.injectNarration(text);
    this.addEntry(text, 'assistant');
  }

  addEntry(text: string, role: TranscriptEntry['role']): void {
    this.logs.transcript(role, text);
    this.transcript.update((entries) => {
      const next = [...entries, { id: _nextId++, text, role }];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }

  private syncAppState(): void {
    if (this._jobRunning()) {
      this.appState.transitionTo('working');
    } else if (this._voiceActivated()) {
      this.appState.transitionTo('listening');
    } else if (this.conversationActive()) {
      this.appState.transitionTo('inactive');
    } else {
      this.appState.transitionTo('idle');
    }
  }

  private buildCallbacks(): SessionCallbacks {
    return {
      onState: (s) => {
        if (s === 'connected') {
          this.conversationActive.set(true);
          this._voiceActivated.set(false);
          this.syncAppState();
        }
        if (s === 'error') {
          this.toast.error(
            'Voice connection failed',
            'Check provider keys and model, then tap to talk again.',
          );
          this.stopSession();
        }
      },
      onUserTranscript: (text) => this.addEntry(text, 'user'),
      onAssistantTranscript: (text) => this.addEntry(text, 'assistant'),
      onSpeaking: (speaking) => this.bridge.sendSpeakingState(speaking),
      onWorking: () => {
        // Job lifecycle is driven by narration events (job_started / job_done).
        this.syncAppState();
      },
      onClosed: () => this.stopSession(),
      onActivated: (phrase) => {
        this.logs.append('info', 'voice', `Activated — "${phrase}"`);
        this._voiceActivated.set(true);
        this.syncAppState();
      },
      onDeactivated: (phrase) => {
        this.logs.append('info', 'voice', `Deactivated — "${phrase}"`);
        this._voiceActivated.set(false);
        this.syncAppState();
      },
      relayToolCall: (callId, name, args) =>
        this.bridge.relayToolCall(callId, name, args),
    };
  }

  private resolveTransport(): 'webrtc' | 'bedrock_ws' {
    const provider = this.voiceProviders.data()?.defaultProvider;
    return provider === 'amazon_bedrock' ? 'bedrock_ws' : 'webrtc';
  }
}
