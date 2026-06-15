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

import { AppStateService } from '../../services/app-state.service';
import { BridgeService } from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { VoiceSessionService } from '../../services/voice-session.service';
import { VoiceOrbComponent } from '../voice-orb/voice-orb.component';

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
  protected wakeStart = '';
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
    return (
      this.bridge.wsStatus() !== 'connected' ||
      !hasModel ||
      !this.bridge.activeProject()
    );
  });

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
    const start = this.voiceProviders.data()?.wakeWords.start ?? this.wakeStart;
    const st = this.appState.state();
    if (st === 'working') {
      return `Cursor is working in the background. You can still speak. Tap the orb to hang up.`;
    }
    if (st === 'inactive' && this.voiceSession.conversationActive()) {
      return `Mic is on. Say "${start}" to activate. Tap the orb to hang up.`;
    }
    return `Tap the orb to connect — project "${this.bridge.activeProject() ?? '…'}" is ready. Say "${start}" to activate. Tap again to hang up.`;
  });

  constructor() {
    effect(() => {
      const active = this.bridge.activeProject();
      if (active) this.selectedProject = active;
    });
    effect(() => {
      const start = this.voiceProviders.data()?.wakeWords.start;
      if (start) this.wakeStart = start;
    });
  }

  protected onProjectChange(name: string | null): void {
    if (!name) return;
    void this.bridge.setActiveProject(name).then(() => {
      this.toast.info('Project updated', name);
      if (this.voiceSession.conversationActive()) {
        this.toast.warn(
          'Restart voice',
          'Hang up and tap the orb again so the new project is picked up.',
        );
      }
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
    if (!start) {
      this.toast.warn('Activation phrase required', 'Set a non-empty phrase in config.');
      return;
    }
    this.savingWakeWords = true;
    try {
      await this.voiceProviders.updateWakeWords(start);
      this.toast.success('Activation phrase updated');
    } catch {
      this.toast.error('Could not save activation phrase');
    } finally {
      this.savingWakeWords = false;
    }
  }
}
