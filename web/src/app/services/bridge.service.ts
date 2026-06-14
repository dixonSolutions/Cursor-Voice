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
  /** Set when REST /api/* calls fail after WS auth (e.g. cross-origin without CORS). */
  readonly apiStatus = signal<'ok' | 'error'>('ok');
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
  private _autoReconnect = true;
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

    this._autoReconnect = true;
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
      this._ws = null;

      if (ev.code === 4001) {
        this.wsStatus.set('error');
        this._rejectAllPending('Bridge WebSocket disconnected');
        this.clearCredentials();
        return;
      }

      if (this._autoReconnect) {
        this.wsStatus.set('error');
        this._rejectAllPending('Bridge WebSocket disconnected');
        this._reconnectTimer = setTimeout(() => this.connect(), 3000);
        return;
      }

      this.wsStatus.set('disconnected');
      this._rejectAllPending('Bridge disconnected');
    });

    this._ws.addEventListener('error', () => {
      this.wsStatus.set('error');
    });
  }

  /** Close the control WebSocket and stop auto-reconnect. Credentials are kept. */
  disconnect(): void {
    this._autoReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.wsStatus.set('disconnected');
    this.apiStatus.set('ok');
    this._rejectAllPending('Bridge disconnected');
  }

  // ── API calls ──────────────────────────────────────────────────────────

  async loadProjects(): Promise<void> {
    try {
      const data = await this.apiFetch<{ projects: Project[] }>('/api/projects');
      this.projects.set(data.projects);
      this.apiStatus.set('ok');

      // Restore last selected project
      const saved = localStorage.getItem('cv_active_project');
      if (saved && data.projects.some((p) => p.name === saved)) {
        this.activeProject.set(saved);
      } else if (data.projects[0]) {
        this.activeProject.set(data.projects[0].name);
      }
    } catch {
      this.apiStatus.set('error');
    }
  }

  async setActiveProject(name: string): Promise<void> {
    await this.apiFetch('/api/active-project', {
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
        this.apiStatus.set('ok');
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

  /** Authenticated fetch to the bridge API. */
  async apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this._bridgeBase}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this._appToken}`,
        'Content-Type': 'application/json',
        ...(opts.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // ignore non-JSON error bodies
      }
      throw new Error(detail);
    }
    return res.json() as Promise<T>;
  }
}
