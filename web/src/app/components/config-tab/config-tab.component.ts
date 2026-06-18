import type { OnInit } from '@angular/core';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Button } from 'primeng/button';
import { Card } from 'primeng/card';
import { Fieldset } from 'primeng/fieldset';
import { Fluid } from 'primeng/fluid';
import { IftaLabel } from 'primeng/iftalabel';
import { InputText } from 'primeng/inputtext';
import { Message } from 'primeng/message';
import { SelectButton } from 'primeng/selectbutton';
import { Tag } from 'primeng/tag';
import { Textarea } from 'primeng/textarea';

import { phrasesConflict } from '../../../wake-words.js';
import { BridgeService } from '../../services/bridge.service';
import { ToastService } from '../../services/toast.service';
import { VoiceProvidersService } from '../../services/voice-providers.service';
import { VoiceSessionService } from '../../services/voice-session.service';
import { ConnectionTabComponent } from '../connection-tab/connection-tab.component';
import { ProvidersTabComponent } from '../providers-tab/providers-tab.component';

type ConfigView = 'form' | 'json';

interface ViewOption {
  label: string;
  value: ConfigView;
}

@Component({
  selector: 'cv-config-tab',
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
    SelectButton,
    Tag,
    Textarea,
    ConnectionTabComponent,
    ProvidersTabComponent,
  ],
  templateUrl: './config-tab.component.html',
})
export class ConfigTabComponent implements OnInit {
  protected readonly bridge = inject(BridgeService);
  protected readonly voiceProviders = inject(VoiceProvidersService);
  protected readonly voiceSession = inject(VoiceSessionService);
  private readonly toast = inject(ToastService);

  protected readonly configView = signal<ConfigView>('form');
  protected readonly viewOptions: ViewOption[] = [
    { label: 'Sections', value: 'form' },
    { label: 'Raw JSON', value: 'json' },
  ];

  protected wakeStart = '';
  protected wakeEnd = 'send';
  protected vadEnabled = true;
  protected silenceSubmitMs = 1500;
  protected savingVoice = false;

  protected rawJson = '';
  protected rawJsonDirty = false;
  protected loadingJson = false;
  protected savingJson = false;

  protected readonly isBridgeConnected = computed(
    () => this.bridge.wsStatus() === 'connected',
  );

  protected readonly showProviders = computed(
    () => (this.bridge.settings()?.workflow.default ?? 'cursor_native') === 's2s_voice',
  );

  protected readonly phraseConflict = computed(() => {
    if (this.vadEnabled) return false;
    return phrasesConflict(this.wakeStart, this.wakeEnd);
  });

  ngOnInit(): void {
    void this.voiceProviders.refresh().then(() => this.syncVoiceForm());
  }

  protected onViewChange(view: ConfigView): void {
    this.configView.set(view);
    if (view === 'json' && !this.rawJsonDirty) {
      void this.loadRawJson();
    }
  }

  protected async onSaveVoiceSettings(): Promise<void> {
    const start = this.wakeStart.trim();
    const end = this.wakeEnd.trim();
    if (!start) {
      this.toast.warn('Activation phrase required', 'Set a non-empty start phrase.');
      return;
    }
    if (!this.vadEnabled && phrasesConflict(start, end)) {
      this.toast.warn('Phrases conflict', 'Wake and end phrases must be different when VAD is off.');
      return;
    }
    const silenceMs = Number(this.silenceSubmitMs);
    if (!Number.isFinite(silenceMs) || silenceMs < 500 || silenceMs > 30_000) {
      this.toast.warn('Invalid silence duration', 'Use a value between 500 and 30000 ms.');
      return;
    }
    this.savingVoice = true;
    try {
      await this.voiceProviders.updateWakeWords(start, end, silenceMs, this.vadEnabled);
      this.syncVoiceForm();
      this.toast.success(
        'Voice settings saved',
        this.voiceSession.conversationActive()
          ? 'Tap the orb to hang up, then start again to apply.'
          : 'Settings apply the next time you tap the orb.',
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not save voice settings', detail);
    } finally {
      this.savingVoice = false;
    }
  }

  protected async loadRawJson(): Promise<void> {
    if (!this.isBridgeConnected()) return;
    this.loadingJson = true;
    try {
      const config = await this.bridge.loadConfigFile();
      this.rawJson = JSON.stringify(config, null, 2);
      this.rawJsonDirty = false;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not load config.json', detail);
    } finally {
      this.loadingJson = false;
    }
  }

  protected onRawJsonEdit(): void {
    this.rawJsonDirty = true;
  }

  protected async saveRawJson(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.rawJson);
    } catch {
      this.toast.warn('Invalid JSON', 'Fix syntax errors before saving.');
      return;
    }
    this.savingJson = true;
    try {
      await this.bridge.saveConfigFile(parsed);
      await this.voiceProviders.refresh();
      this.syncVoiceForm();
      this.rawJsonDirty = false;
      this.toast.success('config.json saved', 'Reload voice session to pick up changes.');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not save config.json', detail);
    } finally {
      this.savingJson = false;
    }
  }

  protected formatRawJson(): void {
    try {
      const parsed = JSON.parse(this.rawJson);
      this.rawJson = JSON.stringify(parsed, null, 2);
      this.rawJsonDirty = true;
    } catch {
      this.toast.warn('Invalid JSON', 'Cannot format until syntax is valid.');
    }
  }

  private syncVoiceForm(): void {
    const data = this.voiceProviders.data();
    if (data?.wakeWords.start) this.wakeStart = data.wakeWords.start;
    if (data?.wakeWords.end) this.wakeEnd = data.wakeWords.end;
    if (data?.turnSubmit.silenceMs) {
      this.silenceSubmitMs = Number(data.turnSubmit.silenceMs);
    }
    if (data?.turnSubmit.vadEnabled !== undefined) {
      this.vadEnabled = data.turnSubmit.vadEnabled;
    }
  }
}
