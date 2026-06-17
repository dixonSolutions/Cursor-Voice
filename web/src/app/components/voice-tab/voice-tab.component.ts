import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { Fieldset } from 'primeng/fieldset';
import { Fluid } from 'primeng/fluid';
import { IftaLabel } from 'primeng/iftalabel';
import { InputText } from 'primeng/inputtext';
import { Message } from 'primeng/message';
import { MultiSelect } from 'primeng/multiselect';
import { Select } from 'primeng/select';
import { Tag } from 'primeng/tag';

import { AppStateService } from '../../services/app-state.service';
import {
  BridgeService,
  NEW_CURSOR_SESSION_ID,
  type CursorSessionEntry,
} from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { VoiceSessionService } from '../../services/voice-session.service';
import { VoiceOrbComponent, type OrbColorMode } from '../voice-orb/voice-orb.component';

interface ProjectOption {
  label: string;
  value: string;
}

interface SessionOption {
  label: string;
  value: string;
  detail?: string;
  isNew?: boolean;
}

@Component({
  selector: 'cv-voice-tab',
  standalone: true,
  imports: [
    FormsModule,
    Button,
    Card,
    Fieldset,
    Fluid,
    IftaLabel,
    InputText,
    Message,
    MultiSelect,
    Select,
    Tag,
    VoiceOrbComponent,
  ],
  templateUrl: './voice-tab.component.html',
})
export class VoiceTabComponent {
  protected readonly bridge = inject(BridgeService);
  protected readonly appState = inject(AppStateService);
  protected readonly voiceSession = inject(VoiceSessionService);
  protected readonly voiceProviders = inject(VoiceProvidersService);
  private readonly toast = inject(ToastService);

  protected selectedProject: string | null = null;
  /** MultiSelect model — enforced to at most one value via selectionLimit. */
  protected selectedSessionIds: string[] = [NEW_CURSOR_SESSION_ID];
  protected readonly cursorSessions = signal<CursorSessionEntry[]>([]);
  protected readonly activeCursorSessionId = signal<string | null>(null);
  protected readonly loadingSessions = signal(false);
  protected wakeStart = '';
  protected wakeEnd = '';
  protected silenceSubmitMs = 1500;
  protected savingWakeWords = false;
  protected typedMessage = '';

  protected readonly activationPhrase = computed(
    () => (this.voiceProviders.data()?.wakeWords.start ?? this.wakeStart) || 'start',
  );

  protected readonly submitPhrase = computed(
    () => (this.voiceProviders.data()?.wakeWords.end ?? this.wakeEnd) || 'send',
  );

  protected readonly silenceSubmitLabel = computed(() => {
    const ms = this.voiceProviders.data()?.turnSubmit.silenceMs ?? this.silenceSubmitMs;
    return `${(ms / 1000).toFixed(1)}s silence`;
  });

  protected readonly workflowHint = computed(() => {
    const start = this.activationPhrase();
    const end = this.submitPhrase();
    const silence = this.silenceSubmitLabel();
    if (this.isCursorNative()) {
      return (
        `Cursor-first voice: say "${start}" to activate, then pause ${silence} or say "${end}" to send. ` +
        'Keep a Cursor agent running with the global cursor-voice MCP (~/.cursor/mcp.json). Type below to test without a mic.'
      );
    }
    return `Say "${start}" to activate. After that, pause ${silence} or say "${end}" to send. Vosk detects start/end offline. Type below to test without a mic.`;
  });

  protected readonly sessionHint = computed(() => {
    const selected = this.selectedSessionIds[0];
    if (!selected || selected === NEW_CURSOR_SESSION_ID) {
      return 'New session — a fresh Cursor thread is created when you start voice.';
    }
    const match = this.cursorSessions().find((s) => s.session_id === selected);
    if (match) {
      return `Continuing thread from ${this.formatSessionDate(match.last_run_at)}. Prompts resume in that session.`;
    }
    return 'Selected session will be used for the next Cursor run.';
  });

  protected readonly audioBackendLabel = computed(() => {
    const backends = this.voiceSession.audioBackends();
    if (!backends) return null;
    const stt =
      backends.stt === 'webkit'
        ? 'WebKit STT'
        : backends.stt === 'amazon_transcribe'
          ? 'Amazon Transcribe'
          : 'Text input';
    const tts =
      backends.tts === 'webkit'
        ? 'WebKit TTS'
        : backends.tts === 'amazon_polly'
          ? 'Amazon Polly'
          : 'No TTS';
    return `${stt} · ${tts}`;
  });

  protected readonly isCascadeWorkflow = computed(() => {
    const workflow = this.bridge.settings()?.workflow.default ?? 'cursor_native';
    return workflow === 'cursor_native' || workflow === 'llm_intelligence';
  });

  protected readonly isCursorNative = computed(
    () => (this.bridge.settings()?.workflow.default ?? 'cursor_native') === 'cursor_native',
  );

  protected readonly showTextInput = computed(
    () => this.isBridgeConnected() && this.isCascadeWorkflow(),
  );

  protected readonly projectOptions = computed<ProjectOption[]>(() =>
    this.bridge.projects().map((p) => ({
      label: p.description ? `${p.name} — ${p.description}` : p.name,
      value: p.name,
    })),
  );

  protected readonly sessionOptions = computed<SessionOption[]>(() => {
    const fromHistory = this.cursorSessions().map((s) => ({
      label: this.formatSessionLabel(s),
      value: s.session_id,
      detail: this.truncatePrompt(s.last_prompt),
    }));
    return [
      {
        label: 'New session',
        value: NEW_CURSOR_SESSION_ID,
        detail: 'Fresh Cursor thread on start',
        isNew: true,
      },
      ...fromHistory,
    ];
  });

  protected readonly activeProviderLabel = computed(() => {
    const data = this.voiceProviders.data();
    if (!data) return null;
    return data.providers.find((p) => p.id === data.defaultProvider)?.displayName ?? null;
  });

  protected readonly activeModelLabel = computed(() => {
    const data = this.voiceProviders.data();
    if (!data) return null;
    const provider = data.providers.find((p) => p.id === data.defaultProvider);
    if (!provider) return null;
    const model = provider.models.find((m) => m.id === provider.defaultModel);
    return model?.label ?? provider.defaultModel;
  });

  protected readonly isBridgeConnected = computed(
    () => this.bridge.wsStatus() === 'connected',
  );

  protected readonly pttDisabled = computed(() => {
    if (this.voiceSession.sessionPrepActive()) return true;
    const workflow = this.bridge.settings()?.workflow.default ?? 'cursor_native';
    if (workflow === 'cursor_native' || workflow === 'llm_intelligence') {
      return (
        this.bridge.wsStatus() !== 'connected' ||
        !this.bridge.activeProject() ||
        this.selectedSessionIds.length === 0
      );
    }
    const data = this.voiceProviders.data();
    const provider = data?.providers.find((p) => p.id === data.defaultProvider);
    const hasModel = Boolean(provider?.defaultModel && provider.viable && provider.registered);
    return (
      this.bridge.wsStatus() !== 'connected' ||
      !hasModel ||
      !this.bridge.activeProject() ||
      this.selectedSessionIds.length === 0
    );
  });

  protected readonly workflowLabel = computed(() => {
    const workflow = this.bridge.settings()?.workflow.default ?? 'cursor_native';
    if (workflow === 'cursor_native') return 'Cursor first';
    if (workflow === 'llm_intelligence') {
      const model = this.bridge.settings()?.workflow.llmIntelligence.model;
      return model ? `Intelligence · ${model}` : 'Intelligence first';
    }
    return this.activeProviderLabel();
  });

  protected readonly orbColorMode = computed((): OrbColorMode => {
    if (!this.voiceSession.conversationActive()) return 'blue';
    if (this.voiceSession.voiceActivated()) return 'green';
    if (this.voiceSession.sessionConnecting()) return 'blue';
    return 'red';
  });

  protected readonly orbActiveStatus = computed((): string | null => {
    if (this.voiceSession.submittingTurn()) return 'Submitting…';
    if (!this.voiceSession.voiceActivated()) {
      if (this.voiceSession.conversationActive()) {
        const start = this.activationPhrase();
        return `Say "${start}" to activate`;
      }
      return null;
    }
    if (this.voiceSession.micMuted()) return 'Muted';
    const tool = this.voiceSession.toolActivity();
    if (tool?.phase === 'start') return tool.label;
    if (this.appState.state() === 'working') return 'Waiting for Cursor…';
    if (this.voiceSession.speaking()) return 'Replying…';
    const levels = this.voiceSession.audioSpectrum();
    if (levels.mic >= 0.028) return 'Speaking…';
    if (this.voiceSession.endPhraseArmed()) {
      const end = this.submitPhrase();
      return `Say "${end}" to send`;
    }
    return 'Ready — speak your request';
  });

  protected readonly showOrbCaption = computed(
    () =>
      this.orbColorMode() === 'blue' ||
      this.voiceSession.submittingTurn() ||
      this.orbActiveStatus() !== null,
  );

  protected readonly orbStateLabel = computed(() => {
    const levels = this.voiceSession.audioSpectrum();
    if (levels.active >= 0.028) {
      return levels.out >= levels.mic ? 'Speaking' : 'Listening';
    }
    if (this.voiceSession.sessionConnecting()) return 'Connecting…';
    if (!this.voiceSession.conversationActive()) return 'Tap to start';
    if (this.appState.state() === 'working') return 'Thinking';
    if (this.appState.state() === 'listening') return 'Ready — speak';
    return 'Mic on — say activation phrase';
  });

  protected readonly pttAriaLabel = computed(() => this.appState.pttLabel());

  protected readonly wakeHint = computed(() => {
    if (this.orbColorMode() === 'red') return null;
    const start = this.voiceProviders.data()?.wakeWords.start ?? this.wakeStart;
    const st = this.appState.state();
    const backends = this.voiceSession.audioBackends();
    if (backends?.stt === 'text_only') {
      return 'No mic STT — type below. Mic path requires WebKit or Amazon Transcribe.';
    }
    if (st === 'inactive' && this.voiceSession.conversationActive()) {
      return `Say "${start}" to activate — other speech is ignored. Or type below. Tap the orb to hang up.`;
    }
    if (st === 'working') {
      return 'Cursor is working — mic pauses while Claude thinks or speaks. Type below anytime.';
    }
    if (st === 'listening' && this.voiceSession.conversationActive()) {
      const end = this.submitPhrase();
      const silence = this.silenceSubmitLabel();
      return `Active — speak, pause ${silence}, or say "${end}" to send. Tap the orb to hang up.`;
    }
    return `Tap the orb — then say "${start}" to activate. Background noise is filtered.`;
  });

  constructor() {
    effect(() => {
      const active = this.bridge.activeProject();
      if (active) {
        this.selectedProject = active;
        void this.loadSessionsForProject(active);
      }
    });
    effect(() => {
      const data = this.voiceProviders.data();
      if (data?.wakeWords.start) this.wakeStart = data.wakeWords.start;
      if (data?.wakeWords.end) this.wakeEnd = data.wakeWords.end;
      if (data?.turnSubmit.silenceMs) this.silenceSubmitMs = data.turnSubmit.silenceMs;
    });
    effect(() => {
      if (this.bridge.wsStatus() === 'connected' && this.selectedProject) {
        void this.loadSessionsForProject(this.selectedProject);
      }
    });
  }

  protected toggleMicMute(): void {
    this.voiceSession.toggleMicMute();
  }

  protected onProjectChange(name: string | null): void {
    if (!name) return;
    void this.bridge.setActiveProject(name).then(async () => {
      this.toast.info('Project updated', name);
      await this.loadSessionsForProject(name);
      if (this.voiceSession.conversationActive()) {
        this.toast.warn(
          'Restart voice',
          'Hang up and tap the orb again so the new project is picked up.',
        );
      }
    });
  }

  protected onSessionChange(ids: string[]): void {
    const next = ids.length > 1 ? [ids[ids.length - 1]!] : ids;
    this.selectedSessionIds = next.length > 0 ? next : [NEW_CURSOR_SESSION_ID];

    const project = this.selectedProject;
    const sessionId = this.selectedSessionIds[0];
    if (!project || !sessionId) return;

    if (sessionId === NEW_CURSOR_SESSION_ID) {
      this.bridge.storeCursorSessionPreference(project, NEW_CURSOR_SESSION_ID);
      return;
    }

    void this.bridge.selectCursorSession(project, sessionId).catch(() => {
      this.toast.error('Could not select session');
    });
  }

  protected handlePtt(): void {
    const st = this.appState.state();
    if (st === 'idle') {
      void this.voiceSession.startSession().then(() => {
        const project = this.selectedProject;
        if (project) void this.loadSessionsForProject(project);
      });
    } else if (st === 'inactive' || st === 'listening' || st === 'working') {
      this.voiceSession.stopSession();
      this.toast.info('Mic off');
    }
  }

  protected sendTypedMessage(): void {
    const text = this.typedMessage.trim();
    if (!text) return;
    void this.voiceSession.sendTextMessage(text);
    this.typedMessage = '';
  }

  protected async onSaveWakeWords(): Promise<void> {
    const start = this.wakeStart.trim();
    const end = this.wakeEnd.trim();
    if (!start) {
      this.toast.warn('Activation phrase required', 'Set a non-empty start phrase in config.');
      return;
    }
    this.savingWakeWords = true;
    try {
      await this.voiceProviders.updateWakeWords(start, end, this.silenceSubmitMs);
      this.toast.success('Voice phrases updated');
    } catch {
      this.toast.error('Could not save voice phrases');
    } finally {
      this.savingWakeWords = false;
    }
  }

  private async loadSessionsForProject(project: string): Promise<void> {
    if (!this.isBridgeConnected()) return;
    this.loadingSessions.set(true);
    try {
      const data = await this.bridge.loadCursorSessions(project);
      const sessions = [...data.sessions];
      if (
        data.active_session_id &&
        !sessions.some((s) => s.session_id === data.active_session_id)
      ) {
        sessions.unshift({
          session_id: data.active_session_id,
          last_prompt: 'Current thread',
          last_status: 'done',
          last_run_at: new Date().toISOString(),
          job_count: 0,
        });
      }
      this.cursorSessions.set(sessions);
      this.activeCursorSessionId.set(data.active_session_id);

      this.selectedSessionIds = [NEW_CURSOR_SESSION_ID];
      this.bridge.storeCursorSessionPreference(project, NEW_CURSOR_SESSION_ID);
    } catch {
      this.cursorSessions.set([]);
      this.selectedSessionIds = [NEW_CURSOR_SESSION_ID];
    } finally {
      this.loadingSessions.set(false);
    }
  }

  private formatSessionLabel(s: CursorSessionEntry): string {
    const id = s.session_id.length > 10 ? `${s.session_id.slice(0, 8)}…` : s.session_id;
    const prompt = this.truncatePrompt(s.last_prompt, 36);
    return prompt ? `${id} — ${prompt}` : id;
  }

  private truncatePrompt(text: string, max = 48): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max - 1)}…`;
  }

  private formatSessionDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }
}
