import { Injectable, inject, signal } from '@angular/core';
import { BedrockVoiceSession } from '../../bedrock-voice.js';
import { WebRTCVoiceSession, type SessionCallbacks } from '../../webrtc.js';
import {
  disposeVoiceAudioMeter,
  getVoiceAudioMeter,
  type AudioSpectrum,
} from '../../voice-audio-meter.js';
import { AppStateService } from './app-state.service';
import { BridgeService } from './bridge.service';
import { LogService } from './log.service';
import { ToastService } from './toast.service';
import { VoiceProvidersService } from './voice-providers.service';
import { cancelTtsFallback, scheduleTtsFallback, speakTtsNow, stopAllTts } from '../../tts-fallback.js';

export interface TranscriptEntry {
  id: number;
  text: string;
  role: 'user' | 'assistant';
}

export interface ToolActivityState {
  tool: string;
  phase: 'start' | 'done' | 'error';
  label: string;
  detail?: string;
  at: number;
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
  private readonly _speaking = signal(false);
  private readonly _jobRunning = signal(false);

  readonly transcript = signal<TranscriptEntry[]>([]);
  readonly toolActivity = signal<ToolActivityState | null>(null);
  readonly conversationActive = signal(false);
  readonly sessionConnecting = signal(false);
  readonly speaking = this._speaking.asReadonly();

  private readonly _audioSpectrum = signal<AudioSpectrum>({
    bins: new Array(32).fill(0),
    mic: 0,
    out: 0,
    active: 0,
  });
  readonly audioSpectrum = this._audioSpectrum.asReadonly();

  /** @deprecated use audioSpectrum */
  readonly audioLevels = this.audioSpectrum;

  private meterRaf = 0;

  isVoiceActivated(): boolean {
    return this._voiceActivated();
  }

  notifyJobRunning(running: boolean): void {
    this._jobRunning.set(running);
    this.syncAppState();
  }

  async startSession(): Promise<void> {
    if (this._session || this.sessionConnecting()) return;

    const project = this.bridge.activeProject();
    if (!project) {
      this.toast.error('Select a project', 'Choose a project in the dropdown before tapping the orb.');
      return;
    }

    this.sessionConnecting.set(true);
    this._voiceActivated.set(false);
    this._jobRunning.set(false);

    try {
      await this.bridge.setActiveProject(project);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not set active project', detail);
      this.sessionConnecting.set(false);
      return;
    }

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
    this._speaking.set(false);
    this._jobRunning.set(false);
    this.bridge.sendSpeakingState(false);
    this.stopMeterPoll();
    this.conversationActive.set(false);
    this.transcript.set([]);
    this.toolActivity.set(null);
    cancelTtsFallback();
    stopAllTts();
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
          this.startMeterPoll();
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
      onAssistantTranscript: (text) => {
        this.addEntry(text, 'assistant');
        scheduleTtsFallback(text, () => this._speaking());
      },
      onSpeaking: (speaking) => {
        if (speaking) cancelTtsFallback();
        this._speaking.set(speaking);
        this.bridge.sendSpeakingState(speaking);
      },
      onWorking: (working) => {
        if (working) this.appState.transitionTo('working');
        this.syncAppState();
      },
      onToolActivity: (event) => {
        this.toolActivity.set({ ...event, at: Date.now() });
        this.logs.append('info', 'voice', event.label, event.detail);
        if (event.phase === 'start') {
          this._jobRunning.set(true);
          this.appState.transitionTo('working');
        } else if (event.phase === 'done' || event.phase === 'error') {
          this._jobRunning.set(false);
          this.syncAppState();
        }
      },
      onClosed: () => this.stopSession(),
      onActivated: (phrase) => {
        this.logs.append('info', 'voice', `Activated — "${phrase}"`);
        this._voiceActivated.set(true);
        this.syncAppState();
      },
      relayToolCall: async (callId, name, args) => {
        this.onToolActivityLocal(name, 'start', args);
        try {
          const result = await this.bridge.relayToolCall(callId, name, args);
          this.onToolActivityLocal(name, 'done', result);
          return result;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.onToolActivityLocal(name, 'error', { error: detail });
          throw err;
        }
      },
    };
  }

  private onToolActivityLocal(
    tool: string,
    phase: 'start' | 'done' | 'error',
    payload: unknown,
  ): void {
    const label = this.formatToolLabel(tool, phase, payload);
    const detail =
      phase === 'error' && payload && typeof payload === 'object'
        ? String((payload as Record<string, unknown>)['error'] ?? '')
        : undefined;
    this.toolActivity.set({ tool, phase, label, detail, at: Date.now() });
    this.logs.append('info', 'voice', label, detail);
    if (phase === 'start') {
      this._jobRunning.set(true);
      this.appState.transitionTo('working');
    } else {
      this._jobRunning.set(false);
      this.syncAppState();
    }
  }

  private formatToolLabel(
    tool: string,
    phase: 'start' | 'done' | 'error',
    payload: unknown,
  ): string {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (phase === 'error') {
      return `${tool.replace(/_/g, ' ')} — failed`;
    }
    if (phase === 'done') {
      if (tool === 'cursor_status' && typeof p['activity'] === 'string') {
        const pid = typeof p['cli_pid'] === 'number' ? ` [pid ${p['cli_pid']}]` : '';
        return `Progress${pid} → ${p['activity']}`;
      }
      if (tool === 'cursor_ask') return 'Cursor answered';
      if (tool === 'cursor_submit') return 'Job started';
      return `${tool.replace(/_/g, ' ')} — done`;
    }
    switch (tool) {
      case 'cursor_set_project':
        return `Setting project → ${String(p['project'] ?? '')}`;
      case 'cursor_ask':
        return `Asking Cursor (CLI) → ${String(p['question'] ?? '').slice(0, 60)}`;
      case 'cursor_submit':
        return `Sending to Cursor → ${String(p['prompt'] ?? '').slice(0, 72)}`;
      case 'cursor_status':
        return 'Checking Cursor progress';
      default:
        return tool.replace(/_/g, ' ');
    }
  }

  private resolveTransport(): 'webrtc' | 'bedrock_ws' {
    const provider = this.voiceProviders.data()?.defaultProvider;
    return provider === 'amazon_bedrock' ? 'bedrock_ws' : 'webrtc';
  }

  private startMeterPoll(): void {
    this.stopMeterPoll();
    const tick = (): void => {
      this._audioSpectrum.set(getVoiceAudioMeter().sample());
      this.meterRaf = requestAnimationFrame(tick);
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  private stopMeterPoll(): void {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = 0;
    disposeVoiceAudioMeter();
    this._audioSpectrum.set({
      bins: new Array(32).fill(0),
      mic: 0,
      out: 0,
      active: 0,
    });
  }
}
