import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { Button } from 'primeng/button';
import { Dialog } from 'primeng/dialog';
import { InputText } from 'primeng/inputtext';
import { Password } from 'primeng/password';
import { ScrollPanel } from 'primeng/scrollpanel';
import { Select } from 'primeng/select';
import { AppStateService } from './services/app-state.service';
import { BridgeService } from './services/bridge.service';
import { VoiceSessionService } from './services/voice-session.service';

interface ProjectOption {
  label: string;
  value: string;
}

@Component({
  selector: 'cv-root',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  standalone: true,
  imports: [
    FormsModule,
    Button,
    Dialog,
    InputText,
    Password,
    ScrollPanel,
    Select,
  ],
})
export class AppComponent implements OnInit, OnDestroy {
  // ── Services ───────────────────────────────────────────────────────────

  protected readonly bridge = inject(BridgeService);
  protected readonly appState = inject(AppStateService);
  protected readonly voiceSession = inject(VoiceSessionService);

  // ── Setup form state ───────────────────────────────────────────────────

  protected tokenInput   = '';
  protected bridgeUrlInput = '';

  // ── Project selector state ─────────────────────────────────────────────

  protected selectedProject: string | null = null;

  // ── Computed ───────────────────────────────────────────────────────────

  protected readonly projectOptions = computed<ProjectOption[]>(() =>
    this.bridge.projects().map((p) => ({
      label: p.description ? `${p.name} — ${p.description}` : p.name,
      value: p.name,
    })),
  );

  protected readonly statusClass = computed<string>(() => {
    const ws = this.bridge.wsStatus();
    const st = this.appState.state();
    if (st === 'working') return 'working';
    if (ws === 'connected') return 'connected';
    if (ws === 'error')     return 'error';
    return 'connecting';
  });

  protected readonly statusLabel = computed<string>(() => {
    const ws = this.bridge.wsStatus();
    const st = this.appState.state();
    if (st === 'working')      return 'Working…';
    if (st === 'listening')    return 'Listening';
    if (ws === 'connected')    return 'Connected';
    if (ws === 'connecting')   return 'Connecting…';
    if (ws === 'error')        return 'Disconnected';
    return 'Not connected';
  });

  // ── Scroll anchor ──────────────────────────────────────────────────────

  @ViewChild('transcriptBottom')
  private transcriptBottom!: ElementRef<HTMLDivElement>;

  // ── Subscriptions ──────────────────────────────────────────────────────

  private _subs = new Subscription();

  // ── Lifecycle ──────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.bridge.loadCredentials();

    if (this.bridge.hasCredentials()) {
      this.bridge.connect();
    }

    // Keep selectedProject in sync with bridge.activeProject
    this._subs.add(
      // Watch activeProject signal via effect-like subscription
      // We use bridge.activeProject as a source for selectedProject binding
      { unsubscribe: () => {} }, // placeholder; we use computed effect below
    );

    // Route narration events from bridge → voice session
    this._subs.add(
      this.bridge.narration$.subscribe((event) => {
        this.voiceSession.addEntry(event.text, 'assistant');
        this.voiceSession.injectNarration(event.text);
        if (event.kind === 'job_done' || event.kind === 'job_error') {
          this.appState.transitionTo('idle');
        }
        this._scrollTranscript();
      }),
    );
  }

  ngOnDestroy(): void {
    this._subs.unsubscribe();
    this.voiceSession.stopSession();
    this.bridge.disconnect();
  }

  // ── Setup dialog ───────────────────────────────────────────────────────

  protected onSaveToken(): void {
    const token = this.tokenInput.trim();
    if (!token) return;
    this.bridge.saveCredentials(token, this.bridgeUrlInput.trim());
    this.tokenInput      = '';
    this.bridgeUrlInput  = '';
    this.bridge.connect();
  }

  // ── Project ────────────────────────────────────────────────────────────

  protected onProjectChange(name: string | null): void {
    if (!name) return;
    void this.bridge.setActiveProject(name).then(() => {
      this.voiceSession.addEntry(`Active project: ${name}`, 'system');
      this._scrollTranscript();
    });
  }

  // ── PTT ────────────────────────────────────────────────────────────────

  protected handlePtt(): void {
    const st = this.appState.state();
    if (st === 'idle') {
      void this.voiceSession.startSession().then(() => this._scrollTranscript());
    } else if (st === 'listening') {
      this.voiceSession.stopSession('Mic off');
      this._scrollTranscript();
    }
    // 'working': button is visually disabled; tap is ignored
  }

  // ── Settings ───────────────────────────────────────────────────────────

  protected onClearCredentials(): void {
    if (!confirm('Clear saved token and bridge URL? You will need to re-enter them.')) {
      return;
    }
    this.voiceSession.stopSession();
    this.bridge.clearCredentials();
  }

  // ── Scroll helper ──────────────────────────────────────────────────────

  private _scrollTranscript(): void {
    // Run after Angular renders the new entry
    setTimeout(() => {
      this.transcriptBottom?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 50);
  }

  // ── Template helpers ───────────────────────────────────────────────────

  /** Called by template effect to keep selectedProject in sync. */
  protected syncProjectSelection(): string | null {
    const ap = this.bridge.activeProject();
    if (ap && ap !== this.selectedProject) {
      this.selectedProject = ap;
    }
    return this.selectedProject;
  }
}
