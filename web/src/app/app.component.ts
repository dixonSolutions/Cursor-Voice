import type { EffectRef, OnDestroy, OnInit } from '@angular/core';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { Avatar } from 'primeng/avatar';
import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { Fluid } from 'primeng/fluid';
import { IftaLabel } from 'primeng/iftalabel';
import { Message } from 'primeng/message';
import { Password } from 'primeng/password';
import { Tag } from 'primeng/tag';
import { Toast } from 'primeng/toast';
import { Toolbar } from 'primeng/toolbar';

import { ConfigTabComponent } from './components/config-tab/config-tab.component';
import { LogsTabComponent } from './components/logs-tab/logs-tab.component';
import { VoiceTabComponent } from './components/voice-tab/voice-tab.component';
import { WakeWordTestComponent } from './components/wake-word-test/wake-word-test.component';
import { AppStateService } from './services/app-state.service';
import { BridgeService } from './services/bridge.service';
import { LogService } from './services/log.service';
import { ToastService } from './services/toast.service';
import { VoiceProvidersService } from './services/voice-providers.service';
import { VoiceSessionService } from './services/voice-session.service';

export type AppTab = 'voice' | 'wake' | 'config' | 'logs';

type TagSeverity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast' | undefined;

interface TabItem {
  id: AppTab;
  label: string;
  icon: string;
}

@Component({
  selector: 'cv-root',
  templateUrl: './app.component.html',
  standalone: true,
  imports: [
    FormsModule,
    Avatar,
    Button,
    Dialog,
    Fluid,
    IftaLabel,
    Message,
    Password,
    Tag,
    Toast,
    Toolbar,
    VoiceTabComponent,
    WakeWordTestComponent,
    ConfigTabComponent,
    LogsTabComponent,
  ],
})
export class AppComponent implements OnInit, OnDestroy {
  protected readonly bridge = inject(BridgeService);
  protected readonly appState = inject(AppStateService);
  protected readonly voiceSession = inject(VoiceSessionService);
  protected readonly voiceProviders = inject(VoiceProvidersService);
  private readonly toast = inject(ToastService);
  private readonly logs = inject(LogService);

  protected tokenInput = '';
  protected readonly activeTab = signal<AppTab>('voice');

  protected readonly tabs: TabItem[] = [
    { id: 'voice', label: 'Voice', icon: 'pi pi-microphone' },
    { id: 'wake', label: 'Wake test', icon: 'pi pi-bolt' },
    { id: 'config', label: 'Config', icon: 'pi pi-cog' },
    { id: 'logs', label: 'Logs', icon: 'pi pi-list' },
  ];

  protected readonly visibleTabs = computed(() => this.tabs);

  /** Hide the top bar while the voice session is live (mic on / listening / working). */
  protected readonly isLiveVoice = computed(() => this.appState.state() !== 'idle');

  protected readonly statusLabel = computed(() => {
    const ws = this.bridge.wsStatus();
    const st = this.appState.state();
    if (this.bridge.apiStatus() === 'error') return 'API blocked';
    if (st === 'working') return 'Working';
    if (st === 'listening') return 'Listening';
    if (st === 'inactive') return 'Mic on';
    if (ws === 'connected') return 'Connected';
    if (ws === 'connecting') return 'Connecting';
    if (ws === 'disconnected') return 'Disconnected';
    if (ws === 'error') return 'Reconnecting…';
    return 'Not connected';
  });

  protected readonly statusSeverity = computed<TagSeverity>(() => {
    const ws = this.bridge.wsStatus();
    const st = this.appState.state();
    if (this.bridge.apiStatus() === 'error') return 'warn';
    if (st === 'working') return 'warn';
    if (ws === 'connected' || st === 'listening') return 'success';
    if (ws === 'error') return 'warn';
    if (ws === 'disconnected') return 'secondary';
    return 'secondary';
  });

  protected readonly statusIcon = computed(() => {
    const st = this.appState.state();
    if (st === 'working') return 'pi pi-spin pi-spinner';
    if (st === 'listening') return 'pi pi-microphone';
    if (this.bridge.wsStatus() === 'connected') return 'pi pi-check-circle';
    if (this.bridge.wsStatus() === 'error') return 'pi pi-sync';
    if (this.bridge.wsStatus() === 'disconnected') return 'pi pi-link';
    return 'pi pi-sync';
  });

  private _connectEffect: EffectRef;
  private _apiWarned = false;
  private _subs = new Subscription();

  constructor() {
    this._connectEffect = effect(() => {
      if (this.bridge.wsStatus() === 'connected') {
        void this.voiceProviders.refresh();
      }
      if (this.bridge.apiStatus() === 'error' && !this._apiWarned) {
        this._apiWarned = true;
        this.toast.warn('API unavailable', 'Check Bridge URL or leave it blank in test mode.');
      }
      if (this.bridge.apiStatus() === 'ok') {
        this._apiWarned = false;
      }
    });
  }

  ngOnInit(): void {
    this.bridge.loadCredentials();
    if (this.bridge.hasCredentials()) {
      this.bridge.connect();
      this.logs.append('info', 'bridge', 'Loaded saved credentials');
    }

    this._subs.add(
      this.bridge.narration$.subscribe((event) => {
        this.voiceSession.injectNarration(event.text);
        if (event.kind === 'job_started') {
          this.voiceSession.notifyJobRunning(true);
        } else if (
          event.kind === 'job_done' ||
          event.kind === 'job_error' ||
          event.kind === 'ghost_killed'
        ) {
          this.voiceSession.notifyJobRunning(false);
        }
      }),
    );
  }

  ngOnDestroy(): void {
    this._connectEffect.destroy();
    this._subs.unsubscribe();
    this.voiceSession.stopSession();
    this.bridge.disconnect();
  }

  protected setTab(tab: AppTab): void {
    this.activeTab.set(tab);
  }

  protected isActiveTab(tab: AppTab): boolean {
    return this.activeTab() === tab;
  }

  protected onSaveToken(): void {
    const token = this.tokenInput.trim();
    if (!token) return;
    this.bridge.saveCredentials(token);
    this.tokenInput = '';
    this.bridge.connect();
    this.logs.append('info', 'bridge', 'Initial credentials saved');
    this.toast.success('Saved', 'Connecting to bridge…');
  }
}
