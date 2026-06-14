# 02 — Architecture

## Components

| Component | Tech | Responsibility |
| --- | --- | --- |
| **Phone PWA** | Vanilla TS + Vite, WebRTC, Web Audio | Mic capture, playback, push-to-talk UI, holds the WebRTC peer connection to the provider, relays tool calls to the bridge |
| **Bridge** | Node 20+, TypeScript, Fastify | Serves the PWA, mints ephemeral provider tokens, authenticated control WebSocket, hosts the MCP tool layer, executes `cursor-agent`, persists state |
| **MCP tool layer** | `@modelcontextprotocol/sdk` | The constrained, validated tool surface (the safety boundary) |
| **Executor** | `node:child_process` + `simple-git` | Spawns `cursor-agent`, parses JSON/NDJSON, manages resume sessions, git revert/diff |
| **Speech provider** | OpenAI Realtime (GA) / Gemini Live | STT + reasoning + TTS, function calling, clarifying questions |
| **cursor-agent** | Cursor CLI | The sole executor of real file/shell work, inside allowlisted projects |
| **Network** | Tailscale (`serve`) | Private mesh + automatic HTTPS for mic access |
| **State** | SQLite (`better-sqlite3`) | Sessions, jobs, project registry, audit log |

## Trust boundaries (high level)

```
[ iPhone Safari PWA ] --WebRTC audio/datachannel--> [ Speech Provider Cloud ]
        |                                                     |
        | (1) authenticated WSS (app token)                   | tool-call events
        v                                                     | over data channel
[ Bridge: token gate ] <----- (2) phone forwards tool calls --+
        |
        | (3) MCP tools (validated, allowlisted)
        v
[ cursor-agent ] --> [ allowlisted project workspaces ] --> git
```

Why this shape (given the WebRTC decision):

- **Audio** flows phone ↔ provider directly = lowest latency (your chosen
  tradeoff).
- **Tool execution** never happens on the phone. Tool-call events arrive on the
  WebRTC **data channel**, the phone **forwards** them to the bridge over an
  **authenticated WebSocket**, the bridge executes and returns the result, and
  the phone injects `function_call_output` back to the provider. The phone is an
  *authenticated relay*, not an executor.
- The provider API key **never** reaches the phone — only short-lived ephemeral
  tokens minted by the bridge do.

See `03-security.md` for the full trust analysis and the rejected
"remote-MCP-by-URL" alternative.

## End-to-end sequence (a voice command)

```
Dad taps push-to-talk (mic latches ON)
  │
  ├─ PWA: POST /api/realtime/token  (app token)  ──► Bridge mints ephemeral
  │        token w/ session+tool config, returns it
  │
  ├─ PWA: establish WebRTC to provider using ephemeral token
  │
Dad: "Cursor… add a dark-mode toggle to the settings page in the budget app"
  │
  ├─ Provider: VAD + transcribe + reason
  ├─ Provider: (maybe) asks a clarifying question → spoken back to Dad
  ├─ Provider: emits function_call  cursor_submit{project:"budget", prompt:"…"}
  │        over the data channel
  │
  ├─ PWA → Bridge (WSS, app token): forward tool call
  ├─ Bridge: validate token → validate args → project in allowlist?
  ├─ Bridge: spawn cursor-agent -p --output-format stream-json \
  │            --workspace <registry path> --resume <id> --force --trust "…"
  ├─ Bridge: Watcher reads NDJSON stdout line-by-line; at key events injects
  │            narration into the realtime session ("Cursor is editing the
  │            component…", "tests are running…") so Dad is never left silent
  ├─ Bridge: final JSON result → parse summary + session_id; persist resume id
  ├─ Bridge → PWA: tool result (summary, session_id, diff stat)
  │
  ├─ PWA → Provider: function_call_output(result)
  ├─ Provider: speaks a conversational summary to Dad
  │
Dad: "Cursor end"  → PWA stops mic / closes session  (or taps button again)
```

For long jobs, the provider's **async function calling** lets it say "give me a
moment" and keep the conversation alive; the bridge can also return immediately
with a `job_id` and the model polls `cursor_status` — both patterns documented in
`05`.

## Process & module layout

```
cursor-voice/
├── docs/                     # ← you are here
├── src/
│   ├── server.ts             # Fastify: static serving, /api routes, control WS
│   ├── config.ts             # env loading + validation (zod)
│   ├── auth.ts               # app-token verification (WS + HTTP)
│   ├── realtime/
│   │   ├── token.ts          # mint ephemeral provider tokens (key stays here)
│   │   ├── session.ts        # session/tool config (single source of truth)
│   │   └── provider.ts       # provider interface (OpenAI ↔ Gemini swap)
│   ├── mcp/
│   │   ├── tools.ts          # tool definitions (zod schemas = source of truth)
│   │   ├── server.ts         # MCP server wiring
│   │   └── handlers.ts       # tool implementations (call executor)
│   ├── executor/
│   │   ├── cursorAgent.ts    # spawn, flag building, NDJSON parsing
│   │   ├── watcher.ts        # stream-json event processor → narration events
│   │   ├── narrator.ts       # narration event → inject into realtime session
│   │   └── git.ts            # simple-git: diff, revert, checkpoint
│   ├── state/
│   │   ├── db.ts             # better-sqlite3 connection + migrations
│   │   └── registry.ts       # project allowlist registry
│   └── log.ts                # structured logging + audit trail
├── web/                      # vanilla TS + Vite PWA
│   ├── index.html
│   ├── src/main.ts           # UI + state machine (idle/listening/working)
│   ├── src/webrtc.ts         # peer connection, data channel, tool relay
│   └── src/audio.ts          # mic + playback glue (mostly native w/ WebRTC)
├── cursor-voice.service      # systemd unit
├── .env.example
├── package.json
└── tsconfig.json
```

Design principles applied (per project rules):

- **Single source of truth** for tool schemas (DRY) — one zod definition emits
  both MCP tools and provider function tools.
- **Swappable provider** behind `provider.ts` (Open/Closed, reusability).
- **All CLI knowledge isolated** in `cursorAgent.ts` (the CLI is beta; contain the churn).
- **Security at the boundary** (`auth.ts` + `registry.ts`), enforced on every
  request, not in the UI.

## State machine (PWA)

```
        tap / "cursor start"
 idle ───────────────────────► listening ──(tool call)──► working
   ▲                              │  ▲                        │
   │   tap again / "cursor end"   │  └──── result spoken ─────┘
   └──────────────────────────────┘
```

`listening` keeps the mic open continuously; the model only *acts* on utterances
prefixed "Cursor…" and treats "cursor end" as a stop verb.

## Latency budget (target, Doherty < 400 ms feel where possible)

| Hop | Target |
| --- | --- |
| Mic → provider first token (WebRTC) | ~200–500 ms (provider-bound) |
| Clarifying question round-trip | conversational, provider-bound |
| Tool call → bridge ack ("working on it") | < 150 ms |
| `cursor_submit` actual work | seconds–minutes (async; narrate progress) |

The UX strategy for the unavoidable long tail is **conversational progress**
("okay, I'm editing the settings page now…"), not silence — see Peak-End Rule and
Doherty Threshold in the UX guidance.
