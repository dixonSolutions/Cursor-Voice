import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface Project {
  name: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
}

export interface NarrationEvent {
  text: string;
  kind?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Bridge service — owns the control WebSocket + HTTP API calls.
 *
 * Responsibilities:
 *   - Credential storage (localStorage)
 *   - WS lifecycle: connect, auth, auto-reconnect
 *   - HTTP: /api/projects, /api/active-project, /api/realtime/token
 *   - Tool-call relay: pendingToolCalls map resolved by WS tool_result frames
 *   - Speaking-state updates forwarded to narrator cadence gate
 *   - Narration events published via narration$ Observable (→ VoiceSessionService)
 */
@Injectable({ providedIn: 'root' })
export class BridgeService {
  // ── Signals ────────────────────────────────────────────────────────────

  readonly hasCredentials = signal<boolean>(false);
  readonly wsStatus = signal<WsStatus>('disconnected');
  readonly projects = signal<Project[]>([]);
  readonly activeProject = signal<string | null>(null);

  // ── Narration observable ───────────────────────────────────────────────

  /** Emits when the bridge pushes a narration event. AppComponent routes to voice session. */
  readonly narration$ = new Subject<NarrationEvent>();

  // ── Private ────────────────────────────────────────────────────────────

  private _appToken = '';
  private _bridgeBase = '';
  private _ws: WebSocket | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingCalls = new Map<string, PendingCall>();

  // ── Credential management ──────────────────────────────────────────────

  loadCredentials(): void {
    const token = localStorage.getItem('cv_token');
    const base  = localStorage.getItem('cv_bridge');
    if (token) {
      this._appToken  = token;
      this._bridgeBase = base ?? window.location.origin;
      this.hasCredentials.set(true);
    }
  }

  saveCredentials(token: string, base: string): void {
    this._appToken   = token;
    this._bridgeBase = base || window.location.origin;
    localStorage.setItem('cv_token',  this._appToken);
    localStorage.setItem('cv_bridge', this._bridgeBase);
    this.hasCredentials.set(true);
  }

  clearCredentials(): void {
    localStorage.removeItem('cv_token');
    localStorage.removeItem('cv_bridge');
    this._appToken   = '';
    this._bridgeBase = '';
    this.hasCredentials.set(false);
    this.disconnect();
  }

  // ── Accessors (used by VoiceSessionService to start WebRTC) ───────────

  get appToken():   string { return this._appToken; }
  get bridgeBase(): string { return this._bridgeBase; }

  // ── WebSocket ──────────────────────────────────────────────────────────

  connect(): void {
    if (this._ws?.readyState === WebSocket.OPEN) return;

    this.wsStatus.set('connecting');
    const wsUrl = this._bridgeBase.replace(/^http/, 'ws') + '/ws/control';
    this._ws = new WebSocket(wsUrl);

    this._ws.addEventListener('open', () => {
      this._ws!.send(JSON.stringify({ type: 'auth', token: this._appToken }));
    });

    this._ws.addEventListener('message', (ev: MessageEvent<string>) => {
      this._handleWsMessage(ev.data);
    });

    this._ws.addEventListener('close', (ev: CloseEvent) => {
      this.wsStatus.set('error');
      this._rejectAllPending('Bridge WebSocket disconnected');

      if (ev.code === 4001) {
        // Bad token — clear and surface the setup dialog
        this.clearCredentials();
        return;
      }
      // Auto-reconnect with a short back-off
      this._reconnectTimer = setTimeout(() => this.connect(), 3000);
    });

    this._ws.addEventListener('error', () => {
      this.wsStatus.set('error');
    });
  }

  disconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._ws?.close();
    this._ws = null;
    this.wsStatus.set('disconnected');
    this._rejectAllPending('Bridge disconnected');
  }

  // ── API calls ──────────────────────────────────────────────────────────

  async loadProjects(): Promise<void> {
    try {
      const data = await this._fetch<{ projects: Project[] }>('/api/projects');
      this.projects.set(data.projects);

      // Restore last selected project
      const saved = localStorage.getItem('cv_active_project');
      if (saved && data.projects.some((p) => p.name === saved)) {
        this.activeProject.set(saved);
      } else if (data.projects[0]) {
        this.activeProject.set(data.projects[0].name);
      }
    } catch {
      // Projects unavailable — non-fatal; transcript will show an error
    }
  }

  async setActiveProject(name: string): Promise<void> {
    await this._fetch('/api/active-project', {
      method: 'POST',
      body: JSON.stringify({ project: name }),
    });
    this.activeProject.set(name);
    localStorage.setItem('cv_active_project', name);
  }

  // ── Tool-call relay ────────────────────────────────────────────────────

  /**
   * Forward a provider function call to the bridge over the control WS.
   * Returns the tool result or throws on error / disconnect.
   * Called by VoiceSessionService for each tool call the voice model emits.
   */
  relayToolCall(callId: string, name: string, args: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const ws = this._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Bridge WebSocket not connected'));
        return;
      }
      this._pendingCalls.set(callId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'tool_call', call_id: callId, name, arguments: args }));
    });
  }

  /** Notify the narrator of TTS activity so it respects cadence (Doherty). */
  sendSpeakingState(speaking: boolean): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'speaking', value: speaking }));
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _handleWsMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      case 'auth_ok':
        this.wsStatus.set('connected');
        void this.loadProjects();
        break;

      case 'narration': {
        const text = msg['text'] as string | undefined;
        const kind = msg['kind'] as string | undefined;
        if (typeof text === 'string' && text) {
          this.narration$.next({ text, kind });
        }
        break;
      }

      case 'tool_result': {
        const callId = msg['call_id'] as string | undefined;
        if (callId) {
          const pending = this._pendingCalls.get(callId);
          if (pending) {
            pending.resolve(msg['result']);
            this._pendingCalls.delete(callId);
          }
        }
        break;
      }

      case 'tool_error': {
        const callId = msg['call_id'] as string | undefined;
        const error  = (msg['error'] as string | undefined) ?? 'Tool error';
        if (callId) {
          const pending = this._pendingCalls.get(callId);
          if (pending) {
            pending.reject(new Error(error));
            this._pendingCalls.delete(callId);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  private _rejectAllPending(reason: string): void {
    for (const { reject } of this._pendingCalls.values()) {
      reject(new Error(reason));
    }
    this._pendingCalls.clear();
  }

  private async _fetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this._bridgeBase}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this._appToken}`,
        'Content-Type': 'application/json',
        ...(opts.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
  }
}
