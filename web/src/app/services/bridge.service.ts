import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export type WsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type WorkflowId = 'cursor_native' | 'llm_intelligence' | 's2s_voice';

export interface AppSettings {
  workflow: {
    default: WorkflowId;
    llmIntelligence: {
      model: string;
      region: string;
    };
  };
  wakeWords?: { start: string; end: string };
  turnSubmit?: { silenceMs: number; vadEnabled?: boolean };
}

export interface Project {
  name: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
}

/** Sentinel value for "start a fresh cursor-agent thread on voice start". */
export const NEW_CURSOR_SESSION_ID = '__new__';

export interface CursorSessionEntry {
  session_id: string;
  last_prompt: string;
  last_status: string;
  last_run_at: string;
  job_count: number;
}

export interface CursorSessionsResponse {
  project: string;
  active_session_id: string | null;
  sessions: CursorSessionEntry[];
}

export interface VoiceSessionLogEvent {
  phase: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

export interface VoiceSessionPrepareResult {
  ok: boolean;
  project: string;
  scope?: 'global';
  message: string;
  mcpPath?: string;
  userRoot?: string;
  hostOs?: string;
  action?: string;
  version?: string;
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
  readonly settings = signal<AppSettings | null>(null);

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

      // Restore last selected project and sync to bridge session state.
      const saved = localStorage.getItem('cv_active_project');
      const name =
        saved && data.projects.some((p) => p.name === saved)
          ? saved
          : data.projects[0]?.name;
      if (name) {
        await this.setActiveProject(name);
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

  async loadCursorSessions(project: string): Promise<CursorSessionsResponse> {
    const q = new URLSearchParams({ project });
    return this.apiFetch<CursorSessionsResponse>(`/api/cursor-sessions?${q}`);
  }

  async selectCursorSession(project: string, sessionId: string): Promise<void> {
    await this.apiFetch('/api/cursor-sessions/select', {
      method: 'POST',
      body: JSON.stringify({ project, session_id: sessionId }),
    });
    localStorage.setItem(this._sessionStorageKey(project), sessionId);
  }

  async createNewCursorSession(
    project: string,
  ): Promise<{ active_session_id: string | null; message: string }> {
    const result = await this.apiFetch<{
      active_session_id: string | null;
      message: string;
    }>('/api/cursor-sessions/new', {
      method: 'POST',
      body: JSON.stringify({ project }),
    });
    if (result.active_session_id) {
      localStorage.setItem(this._sessionStorageKey(project), result.active_session_id);
    } else {
      localStorage.setItem(this._sessionStorageKey(project), NEW_CURSOR_SESSION_ID);
    }
    return result;
  }

  getStoredCursorSession(project: string): string | null {
    return localStorage.getItem(this._sessionStorageKey(project));
  }

  storeCursorSessionPreference(project: string, sessionId: string): void {
    localStorage.setItem(this._sessionStorageKey(project), sessionId);
  }

  /**
   * Apply the user's session choice before voice / submit work begins.
   * "New session" creates a fresh thread; otherwise resume_id is set on the project.
   */
  async ensureCursorSessionReady(project: string): Promise<string | null> {
    const stored = this.getStoredCursorSession(project);
    if (!stored || stored === NEW_CURSOR_SESSION_ID) {
      const created = await this.createNewCursorSession(project);
      return created.active_session_id;
    }
    await this.selectCursorSession(project, stored);
    return stored;
  }

  /**
   * Stream live voice session prep logs (global MCP install / version check / enable).
   * Resolves when the backend sends the `complete` SSE event.
   */
  async prepareVoiceSession(
    project: string,
    onLog: (event: VoiceSessionLogEvent) => void,
  ): Promise<VoiceSessionPrepareResult> {
    const res = await fetch(`${this._bridgeBase}/api/voice-session/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._appToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ project }),
    });

    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }

    if (!res.body) {
      throw new Error('Prepare stream missing response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let complete: VoiceSessionPrepareResult | null = null;

    const processBlock = (block: string): void => {
      const lines = block.split('\n');
      let eventName = 'message';
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
      }
      if (!dataLine) return;
      const payload = JSON.parse(dataLine) as Record<string, unknown>;
      if (eventName === 'session_log') {
        onLog(payload as unknown as VoiceSessionLogEvent);
      } else if (eventName === 'complete') {
        complete = {
          ok: Boolean(payload['ok']),
          project: String(payload['project'] ?? project),
          message: String(payload['message'] ?? ''),
          mcpPath: typeof payload['mcpPath'] === 'string' ? payload['mcpPath'] : undefined,
          action: typeof payload['action'] === 'string' ? payload['action'] : undefined,
          version: typeof payload['version'] === 'string' ? payload['version'] : undefined,
        };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim()) processBlock(part);
      }
    }

    if (buffer.trim()) processBlock(buffer);

    if (!complete) {
      throw new Error('Prepare stream ended without completion');
    }
    const result: VoiceSessionPrepareResult = complete;
    if (!result.ok) {
      throw new Error(result.message || 'Voice session preparation failed');
    }
    return result;
  }

  private _sessionStorageKey(project: string): string {
    return `cv_cursor_session_${project}`;
  }

  async loadSettings(): Promise<void> {
    try {
      const data = await this.apiFetch<AppSettings>('/api/settings');
      this.settings.set(data);
      this.apiStatus.set('ok');
    } catch {
      this.apiStatus.set('error');
    }
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
        void this.loadSettings();
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

  async loadConfigFile(): Promise<Record<string, unknown>> {
    return this.apiFetch<Record<string, unknown>>('/api/config');
  }

  async saveConfigFile(config: unknown): Promise<void> {
    await this.apiFetch<{ ok: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
    await this.loadSettings();
  }
}
