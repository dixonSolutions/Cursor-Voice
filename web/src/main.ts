/**
 * Cursor Voice PWA — main entry.
 *
 * Wires the UI state machine to the bridge API and the WebRTC voice session.
 *
 * ## State machine
 *
 *   idle ──tap / "cursor start"──► listening ──tool call──► working
 *     ▲                               │   ▲                    │
 *     └── tap / "cursor end" ─────────┘   └─ result spoken ────┘
 *
 * ## Responsibilities
 *
 *   - Token/credential storage (localStorage)
 *   - Bridge control WebSocket: auth, narration relay, tool-call relay
 *   - WebRTC session lifecycle: start on PTT tap, close on re-tap or "cursor end"
 *   - Pending tool-call map: bridge WS carries async tool results back to session
 *   - Speaking state: forwarded to bridge so narrator respects cadence
 *   - Transcript log: shows user + assistant speech + system events
 *   - Project dropdown: GET /api/projects → POST /api/active-project
 */

import { WebRTCVoiceSession } from './webrtc.js';

// ── Types ──────────────────────────────────────────────────────────────────

type AppState = 'idle' | 'listening' | 'working';

interface Project {
  name: string;
  description: string | null;
  aliases: string[];
  enabled: boolean;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

// ── State ──────────────────────────────────────────────────────────────────

let state: AppState = 'idle';
let ws: WebSocket | null = null;
let bridgeBase = '';
let appToken = '';
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let activeSession: WebRTCVoiceSession | null = null;

/** Pending tool calls awaiting a result from the bridge WS. */
const pendingToolCalls = new Map<string, PendingCall>();

// ── DOM elements ───────────────────────────────────────────────────────────

const overlay = document.getElementById('token-overlay') as HTMLDivElement;
const tokenInput = document.getElementById('token-input') as HTMLInputElement;
const bridgeUrlInput = document.getElementById('bridge-url-input') as HTMLInputElement;
const saveTokenBtn = document.getElementById('save-token-btn') as HTMLButtonElement;
const statusBadge = document.getElementById('status-badge') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const pttBtn = document.getElementById('ptt-btn') as HTMLButtonElement;
const pttLabel = document.getElementById('ptt-label') as HTMLSpanElement;
const projectSelect = document.getElementById('project-select') as HTMLSelectElement;
const transcript = document.getElementById('transcript') as HTMLDivElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;

// ── Token / config persistence ─────────────────────────────────────────────

function loadSavedCredentials(): boolean {
  const savedToken = localStorage.getItem('cv_token');
  const savedBase = localStorage.getItem('cv_bridge');
  if (savedToken) {
    appToken = savedToken;
    bridgeBase = savedBase ?? window.location.origin;
    return true;
  }
  return false;
}

function saveCredentials(): void {
  localStorage.setItem('cv_token', appToken);
  localStorage.setItem('cv_bridge', bridgeBase);
}

function clearCredentials(): void {
  localStorage.removeItem('cv_token');
  localStorage.removeItem('cv_bridge');
  appToken = '';
  bridgeBase = '';
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setStatus(status: 'connecting' | 'connected' | 'error' | 'working', label: string): void {
  statusBadge.className = status === 'connecting' ? '' : status;
  statusText.textContent = label;
}

function appendTranscript(
  text: string,
  role: 'user' | 'assistant' | 'system' | 'error',
): void {
  const el = document.createElement('div');
  el.className = `transcript-entry ${role}`;
  el.textContent = text;
  transcript.appendChild(el);
  // Keep last 50 entries — Miller's Law + performance
  while (transcript.children.length > 50) {
    transcript.firstChild?.remove();
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function transitionTo(newState: AppState): void {
  state = newState;
  switch (newState) {
    case 'idle':
      pttBtn.classList.remove('active');
      pttLabel.textContent = 'TAP TO TALK';
      setStatus('connected', 'Connected');
      break;
    case 'listening':
      pttBtn.classList.add('active');
      pttLabel.textContent = 'LISTENING…';
      setStatus('connected', 'Listening');
      break;
    case 'working':
      pttBtn.classList.remove('active');
      pttLabel.textContent = 'WORKING…';
      setStatus('working', 'Working');
      break;
  }
}

// ── API helpers ────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${bridgeBase}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function loadProjects(): Promise<void> {
  try {
    const data = await apiFetch<{ projects: Project[] }>('/api/projects');
    const projects = data.projects;

    projectSelect.innerHTML = '';
    if (projects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No projects registered';
      projectSelect.appendChild(opt);
      return;
    }

    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.description ? `${p.name} — ${p.description}` : p.name;
      projectSelect.appendChild(opt);
    }

    const saved = localStorage.getItem('cv_active_project');
    if (saved && projects.some((p) => p.name === saved)) {
      projectSelect.value = saved;
    } else if (projects[0]) {
      projectSelect.value = projects[0].name;
    }
  } catch (err) {
    appendTranscript(`Failed to load projects: ${String(err)}`, 'error');
  }
}

async function setProject(name: string): Promise<void> {
  try {
    await apiFetch('/api/active-project', {
      method: 'POST',
      body: JSON.stringify({ project: name }),
    });
    localStorage.setItem('cv_active_project', name);
    appendTranscript(`Active project: ${name}`, 'system');
  } catch (err) {
    appendTranscript(`Failed to set project: ${String(err)}`, 'error');
  }
}

// ── Speaking state ─────────────────────────────────────────────────────────

/**
 * Notify the bridge narrator that TTS is active or has ended.
 * The bridge uses this to gate narration injections so they don't
 * interrupt ongoing speech (Doherty / Peak-End rule).
 */
function sendSpeakingState(speaking: boolean): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'speaking', value: speaking }));
  }
}

// ── Tool-call relay ────────────────────────────────────────────────────────

/**
 * Forward a provider function call to the bridge control WS.
 * Returns the tool result (or throws on error / WS disconnect).
 *
 * The bridge validates args, resolves the project, executes the tool, and
 * returns the result — the phone is a relay, it executes nothing itself.
 */
function relayToolCall(callId: string, name: string, args: unknown): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Bridge WebSocket not connected'));
      return;
    }
    pendingToolCalls.set(callId, { resolve, reject });
    ws.send(
      JSON.stringify({ type: 'tool_call', call_id: callId, name, arguments: args }),
    );
  });
}

/** Reject all pending tool calls (called on WS close to unblock sessions). */
function rejectPendingToolCalls(reason: string): void {
  for (const { reject } of pendingToolCalls.values()) {
    reject(new Error(reason));
  }
  pendingToolCalls.clear();
}

// ── WebSocket control channel ──────────────────────────────────────────────

function connectWs(): void {
  if (ws?.readyState === WebSocket.OPEN) return;

  const wsUrl = bridgeBase.replace(/^http/, 'ws') + '/ws/control';
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    ws!.send(JSON.stringify({ type: 'auth', token: appToken }));
  });

  ws.addEventListener('message', (ev: MessageEvent<string>) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      case 'auth_ok':
        setStatus('connected', 'Connected');
        appendTranscript('Connected to bridge', 'system');
        void loadProjects();
        break;

      case 'narration': {
        const text = msg['text'] as string | undefined;
        const kind = msg['kind'] as string | undefined;
        if (typeof text === 'string' && text) {
          // Show in transcript log
          appendTranscript(text, 'assistant');
          // Forward to provider so it TTS's it for Dad
          activeSession?.injectNarration(text);
          if (kind === 'job_done' || kind === 'job_error') {
            transitionTo('idle');
          }
        }
        break;
      }

      case 'tool_result': {
        const callId = msg['call_id'] as string | undefined;
        const result = msg['result'];
        if (callId) {
          const pending = pendingToolCalls.get(callId);
          if (pending) {
            pending.resolve(result);
            pendingToolCalls.delete(callId);
          }
        }
        break;
      }

      case 'tool_error': {
        const callId = msg['call_id'] as string | undefined;
        const error = (msg['error'] as string | undefined) ?? 'Tool error';
        if (callId) {
          const pending = pendingToolCalls.get(callId);
          if (pending) {
            pending.reject(new Error(error));
            pendingToolCalls.delete(callId);
          }
        }
        break;
      }

      default:
        break;
    }
  });

  ws.addEventListener('close', (ev: CloseEvent) => {
    setStatus('error', 'Disconnected');
    rejectPendingToolCalls('Bridge WebSocket disconnected');

    if (ev.code === 4001) {
      appendTranscript('Auth failed — check your token in Settings', 'error');
      clearCredentials();
      overlay.classList.remove('hidden');
      return;
    }

    wsReconnectTimer = setTimeout(() => {
      setStatus('connecting', 'Reconnecting…');
      connectWs();
    }, 3000);
  });

  ws.addEventListener('error', () => {
    setStatus('error', 'Connection error');
  });
}

// ── PTT toggle logic ───────────────────────────────────────────────────────

/**
 * Tear down the active WebRTC session and reset to idle.
 * Safe to call when no session is active.
 */
function stopSession(reason?: string): void {
  if (activeSession) {
    activeSession.close();
    activeSession = null;
    sendSpeakingState(false);
  }
  rejectPendingToolCalls('Session closed');
  if (reason) {
    appendTranscript(`[${reason}]`, 'system');
  }
  transitionTo('idle');
}

/**
 * PTT tap handler — latching toggle.
 *   idle → start WebRTC session → listening
 *   listening → close session → idle
 *   working → ignored (job in flight; button disabled)
 */
function handlePtt(): void {
  if (state === 'idle') {
    void startSession();
  } else if (state === 'listening') {
    stopSession('Mic off');
  }
  // 'working': button is non-functional while agent is executing
}

async function startSession(): Promise<void> {
  // Prevent double-tap races
  if (activeSession) return;

  transitionTo('listening');
  appendTranscript('[Mic on — say "Cursor…" to begin a command]', 'system');

  const session = new WebRTCVoiceSession(bridgeBase, appToken, {
    onState(s) {
      if (s === 'error') {
        appendTranscript('Voice connection error — tap to retry', 'error');
        stopSession();
      }
    },
    onUserTranscript(text) {
      appendTranscript(`You: ${text}`, 'user');
    },
    onAssistantTranscript(text) {
      appendTranscript(`Cursor: ${text}`, 'assistant');
    },
    onSpeaking(speaking) {
      sendSpeakingState(speaking);
    },
    onWorking(active) {
      if (active) {
        transitionTo('working');
      } else if (state === 'working') {
        transitionTo('listening');
      }
    },
    onClosed(reason) {
      stopSession(reason ?? 'Session closed');
    },
    relayToolCall,
  });

  activeSession = session;

  try {
    await session.start();
  } catch (err) {
    appendTranscript(`Could not start voice: ${String(err)}`, 'error');
    stopSession();
  }
}

// ── Event listeners ────────────────────────────────────────────────────────

saveTokenBtn.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (!token) {
    tokenInput.focus();
    return;
  }
  appToken = token;
  bridgeBase = bridgeUrlInput.value.trim() || window.location.origin;
  saveCredentials();
  overlay.classList.add('hidden');
  setStatus('connecting', 'Connecting…');
  connectWs();
});

tokenInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') saveTokenBtn.click();
});

pttBtn.addEventListener('click', handlePtt);

projectSelect.addEventListener('change', () => {
  if (projectSelect.value) {
    void setProject(projectSelect.value);
  }
});

settingsBtn.addEventListener('click', () => {
  const confirmed = confirm(
    'Clear saved token and bridge URL? You will need to re-enter them.',
  );
  if (confirmed) {
    stopSession();
    clearCredentials();
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    ws?.close();
    overlay.classList.remove('hidden');
    tokenInput.value = '';
    bridgeUrlInput.value = '';
    setStatus('connecting', 'Not connected');
  }
});

// ── Boot ───────────────────────────────────────────────────────────────────

if (loadSavedCredentials()) {
  overlay.classList.add('hidden');
  setStatus('connecting', 'Connecting…');
  connectWs();
} else {
  setStatus('connecting', 'Not connected');
}
