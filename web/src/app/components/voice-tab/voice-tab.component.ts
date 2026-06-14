import { Component, computed, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { Fieldset } from 'primeng/fieldset';
import { Fluid } from 'primeng/fluid';
import { IftaLabel } from 'primeng/iftalabel';
import { InputText } from 'primeng/inputtext';
import { Message } from 'primeng/message';
import { Select } from 'primeng/select';
import { Tag } from 'primeng/tag';
import { Toolbar } from 'primeng/toolbar';

import { AppStateService } from '../../services/app-state.service';
import { BridgeService } from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { VoiceSessionService } from '../../services/voice-session.service';

interface ProjectOption {
  label: string;
  value: string;
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
    Select,
    Tag,
    Toolbar,
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
  protected wakeStart = 'cursor listen';
  protected wakeStop = 'cursor stop';
  protected savingWakeWords = false;

  protected readonly projectOptions = computed<ProjectOption[]>(() =>
    this.bridge.projects().map((p) => ({
      label: p.description ? `${p.name} — ${p.description}` : p.name,
      value: p.name,
    })),
  );

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
    const data = this.voiceProviders.data();
    const provider = data?.providers.find((p) => p.id === data.defaultProvider);
    const hasModel = Boolean(provider?.defaultModel && provider.viable && provider.registered);
    return this.bridge.wsStatus() !== 'connected' || !hasModel;
  });

  protected readonly pttSeverity = computed(() => {
    const st = this.appState.state();
    if (st === 'working') return 'warn' as const;
    if (st === 'listening') return 'danger' as const;
    if (st === 'inactive') return 'secondary' as const;
    return 'primary' as const;
  });

  protected readonly pttIcon = computed(() => {
    if (this.appState.state() === 'working') return 'pi pi-spin pi-spinner';
    return 'pi pi-microphone';
  });

  protected readonly pttAriaLabel = computed(() => this.appState.pttLabel());

  protected readonly wakeHint = computed(() => {
    const start = this.voiceProviders.data()?.wakeWords.start ?? this.wakeStart;
    const stop = this.voiceProviders.data()?.wakeWords.stop ?? this.wakeStop;
    const st = this.appState.state();
    if (st === 'working') {
      return `Cursor is working in the background. Say "${start}" to ask a question, "${stop}" when done talking. Tap mic to hang up.`;
    }
    if (st === 'inactive' && this.voiceSession.conversationActive()) {
      return `Mic is on. Say "${start}" to talk, "${stop}" when done. Tap mic to hang up.`;
    }
    return `Tap mic — say "${start}" to activate, "${stop}" to stop listening. Tap again to hang up.`;
  });

  constructor() {
    effect(() => {
      const active = this.bridge.activeProject();
      if (active) this.selectedProject = active;
    });
    effect(() => {
      const ww = this.voiceProviders.data()?.wakeWords;
      if (ww) {
        this.wakeStart = ww.start;
        this.wakeStop = ww.stop;
      }
    });
  }

  protected onProjectChange(name: string | null): void {
    if (!name) return;
    void this.bridge.setActiveProject(name).then(() => {
      this.toast.info('Project updated', name);
    });
  }

  protected handlePtt(): void {
    const st = this.appState.state();
    if (st === 'idle') {
      void this.voiceSession.startSession();
    } else if (st === 'inactive' || st === 'listening' || st === 'working') {
      this.voiceSession.stopSession();
      this.toast.info('Mic off');
    }
  }

  protected async onSaveWakeWords(): Promise<void> {
    const start = this.wakeStart.trim();
    const stop = this.wakeStop.trim();
    if (!start || !stop) {
      this.toast.warn('Wake words required', 'Both start and stop phrases must be non-empty.');
      return;
    }
    this.savingWakeWords = true;
    try {
      await this.voiceProviders.updateWakeWords(start, stop);
      this.toast.success('Wake words updated');
    } catch {
      this.toast.error('Could not save wake words');
    } finally {
      this.savingWakeWords = false;
    }
  }
}
