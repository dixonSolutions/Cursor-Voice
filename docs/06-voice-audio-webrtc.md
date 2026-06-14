# 06 — Voice, Audio & WebRTC

Covers the phone-side voice experience: WebRTC connection, ephemeral tokens,
the push-to-talk toggle, "cursor start/end" voice control, the "Cursor…" intent
prefix, and how tool calls are routed securely.

## Why WebRTC (confirmed decision)

Browser WebRTC handles mic capture, Opus encoding, echo cancellation, jitter
buffering, packet loss concealment, and playback **natively**. Compared to the
original "AudioWorklet → 24 kHz PCM → base64 → WebSocket relay → manual playback"
path, WebRTC is **lower latency and far less custom audio code**. Providers
explicitly recommend WebRTC for browser audio.

Tradeoff (accepted): audio goes phone ↔ provider directly, so **tool calls must
be routed back through the phone** to the bridge. We secure that path (below).

## Ephemeral token flow (API key never on the phone)

```
PWA                              Bridge                         Provider
 │  POST /api/realtime/token      │                               │
 │  Authorization: Bearer <app>   │                               │
 │ ──────────────────────────────►│  validate app token           │
 │                                 │  POST /v1/realtime/client_secrets
 │                                 │   (session config + tools, short TTL)
 │                                 │ ─────────────────────────────►│
 │                                 │ ◄───────────── ephemeral token │
 │ ◄───────────── ephemeral token  │                               │
 │  establish WebRTC using ephemeral token  ─────────────────────►│
```

- The bridge bakes the **session config** (system prompt, voice, language hints
  for Polish + English, VAD, **tool/function definitions**) into the token
  request so the phone can't tamper with capabilities.
- TTL as short as practical; the PWA re-mints when needed.
- The provider API key lives **only** on the bridge (`.env`).

## GA session configuration (target the GA schema, not beta)

Key points validated for the GA Realtime API:

- `session.type: "realtime"` (not the beta `"conversation"`).
- Audio config under `session.audio.input` / `session.audio.output`
  (voice lives under `audio.output`).
- Use `output_modalities` (not a top-level `modalities`).
- **Do not** send `OpenAI-Beta: realtime=v1`.
- Newer event names: `response.output_audio.delta`,
  `response.output_audio_transcript.delta`, `response.output_text.delta`,
  function calls surface on `response.done` (and via
  `response.function_call_arguments.*`).
- Provide a **system prompt** that enforces the product behavior:
  - Only act on utterances directed at it via the **"Cursor…" prefix**; treat
    other speech as ambient/ignored.
    - Recognize **"cursor end"** (and "cursor stop"/"that's all") as the stop verb.
  - Ask **clarifying questions** when a request is ambiguous before calling
    `cursor_submit`.
  - Narrate progress conversationally during long jobs (Doherty/Peak-End).
  - Reply in the **same language** the user spoke (Polish or English).
  - Know the **project catalog** (names + aliases + descriptions are injected
    into the session) and follow the project-selection rules below.

## Project selection (two ways, one registry)

Dad can choose the active project **two interchangeable ways**, both backed by the
same `config.json` registry and the same server-side validation:

1. **Manually, in the web app** — a project dropdown/select (good for the first
   pick when he opens the app, or when voice mishears).
2. **By voice** — the agent views/searches/selects from the list (good once he's
   hands-free).

Either way the result is the same: a single **active project** for the session
(`session_state.active_project`, see `07`). A manual pick and a voice pick update
the *same* state, so the two stay in sync — if dad taps "budget" in the dropdown,
the voice agent now treats "budget" as active, and vice-versa.

### Manual selection — web app dropdown

```
App load
  │  GET /api/projects  (app token)  ──► bridge returns enabled projects
  │       [{ name, description }]        from the registry (NOT paths)
  ▼
Dad picks "Budget app" from the <select>
  │  POST /api/active-project { name:"budget" }  (app token)
  ▼
Bridge validates name ∈ registry → sets session_state.active_project
  ▼
UI shows active project badge; voice session is told the new active project
```

- The dropdown is populated **only** from the server (`GET /api/projects`); the
  web app never sees or sends filesystem paths — it sends the **name**, the
  bridge resolves the path (security at the API level; the frontend list is a
  convenience, not the authority).
- Follows UX guidance: a clear, labeled select with descriptions (Hick's Law —
  few, well-described options; Law of Common Region — grouped with the active
  badge). Recommended placement: top of the screen, above the push-to-talk
  button, so the current target is always visible.
- Disabled/again-removed projects never appear (registry `enabled` flag).

### Voice selection

This is how dad tells the agent *which* codebase to work on by speaking. Design
goals: say it once, recover gracefully from mishears, and never run against the
wrong project.

### Three ways to choose, in order of preference

1. **Sticky active project (default).** "Cursor, switch to the budget app" →
   `cursor_set_project("budget")`. From then on every command targets it until
   changed. Dad doesn't repeat the name each sentence (Miller's Law: less to
   hold in working memory). The UI shows the active project as a persistent
   badge so the current target is always visible (Law of Common Region).
2. **Inline override.** "Cursor, in the website, fix the footer" → the model
   passes `project:"website"` on that single `cursor_submit` without changing the
   sticky default.
3. **Discovery.** "Cursor, what can I work on?" → `cursor_list_projects` →
   the model reads back the catalog with descriptions.

### Resolution & disambiguation flow

```
utterance mentions a project
   │
   ├─ model maps speech → candidate (using injected catalog)
   ├─ bridge resolves name/alias/fuzzy + checks allowlist
   │
   ├─ unique confident match ──► proceed (optionally read back for risky ops)
   ├─ multiple/none/low-confidence ──► bridge returns needs_disambiguation
   │        └─ model: "I have budget, website, and game — which one?"
   └─ no project set + none given ──► bridge returns no_active_project
            └─ model asks which project before doing anything
```

- **First command of a session** with no active project → the model must ask /
  set a project before `cursor_submit`. No silent default.
- **Readback policy:** confirm the target only when confidence is low or the
  intent is destructive (revert, "delete…"). Don't confirm every call — that
  breaks flow and nags.
- **Switch confirmation:** on `cursor_set_project`, the model speaks the new
  active project + its description ("Okay, now working on **budget** — the
  finance tracker") so a mishear is caught immediately, before any edits.

### Making names robust to STT

- Canonical names should be **short, distinct, low phonetic collision** (avoid
  "site" vs "sight", "test" vs "text").
- `aliases[]` capture how dad naturally refers to each project, so the model maps
  casual speech without a perfect name match.
- The fuzzy backstop (server-side) catches near-misses and routes to
  disambiguation rather than guessing.

## Push-to-talk model (confirmed behavior)

Primary control is a **latching toggle**, not hold-to-talk:

- **Tap once → mic ON (latched).** Conversation stays open continuously; dad can
  speak naturally. The model only *acts* on "Cursor…"-prefixed utterances.
- **Tap again → mic OFF.** WebRTC connection torn down (or muted), session ends.
- Additionally, **voice control while open**:
  - **"cursor start"** — (re)activate / begin acting (useful after a pause).
  - **"cursor end"** — stop the session and release the mic.

### The "cursor start" when mic is OFF — design + caveat

To hear "cursor start" while the mic is fully off, you need an always-listening
path, which Safari makes unreliable/battery-heavy in the foreground and
impossible reliably in the background. Decision (v1): **the button is the
authoritative on switch**; "cursor start" / "cursor end" operate **while the mic
session is open** (start = begin acting / resume after idle; end = close).

Optional **v2 enhancement** (documented, off by default): a lightweight on-device
keyword spotter (e.g., a small WASM wake-word model) that listens *only* for
"cursor start" to flip the latch on. Flagged as opt-in due to battery and
reliability; do not block v1 on it. (Tracked in `08`.)

### UI state machine

```
 idle ──tap / "cursor start"──► listening ──tool call──► working
   ▲                               │   ▲                    │
   └── tap / "cursor end" ─────────┘   └─ result spoken ────┘
```

UI follows the UX guidance:

- **One primary target**: a large, central push-to-talk button (Fitts's Law:
  big, reachable, thumb-friendly).
- **Clear status** (idle / listening / working / error) via color + label
  (Contrast, Von Restorff for the active state).
- **Transcript log** of what was heard and what the agent did (Zeigarnik:
  surfaces in-progress work; builds trust).
- **Connection indicator** (mic, network, agent).
- Minimal choices on screen (Hick's Law); consistent with familiar voice-app
  patterns (Jakob's Law).

## Tool-call routing (secure relay)

```
Provider ──function_call (data channel)──► PWA
PWA ──WSS {type:"tool_call", token, name, args, call_id}──► Bridge
Bridge: validate token → validate args → dispatch handler → execute
Bridge ──WSS {type:"tool_result", call_id, result}──► PWA
PWA ──function_call_output(result)──► Provider
Provider ──speaks summary──► Dad
```

- The phone is an **authenticated relay**; it cannot execute tools itself.
- For **long jobs**, two compatible patterns:
  1. **Async function calling** — provider keeps talking ("one moment…") while
     the call is outstanding; bridge returns when done.
  2. **Job + poll** — `cursor_submit` returns a `job_id` quickly; the model calls
     `cursor_status` periodically and narrates progress.
  Recommend supporting both; prefer async function calling where the provider
  supports it cleanly.

## Audio specifics (mostly handled by WebRTC)

- With WebRTC you generally **don't** manually resample/chunk; the browser sends
  a media track and receives a remote track you attach to an `<audio>` element.
- If a WebSocket fallback is ever needed (e.g., provider/transport issue), the
  fallback path is base64 **24 kHz mono PCM16** both directions — documented as a
  contingency, not the primary path.
- iOS audio gotchas to handle: unlock `AudioContext` on the first user tap
  (autoplay policy), keep the screen-awake consideration for long sessions, and
  handle interruptions (calls, Siri) by re-establishing the connection.

## PWA delivery

- Vanilla TS + Vite, served as static files by the bridge over the Tailscale
  HTTPS origin (required for mic).
- Add-to-Home-Screen manifest + icons for app-like launch.
- Token entered once, stored in `localStorage`; clearable.
