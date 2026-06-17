# Cursor Voice — Documentation

Voice-controlled coding agent: a non-technical user speaks (push-to-talk, with a
"Cursor…" intent prefix) from an iPhone, a speech-to-speech model drafts and
refines prompts, and a constrained MCP tool layer drives `cursor-agent` to do the
actual work on projects hosted on a home machine.

> Status: **Planning / pre-implementation.** This folder is the source of truth
> for the design. Code does not exist yet. Update these docs as decisions change
> (see `08-decisions-and-risks.md`).

## How to read these docs

| Doc | What it covers | Read it when |
| --- | --- | --- |
| [`01-critical-analysis.md`](./01-critical-analysis.md) | Honest, component-by-component feasibility critique of the original proposal | You want to know what's solid, what's risky, and what changed |
| [`02-architecture.md`](./02-architecture.md) | Final system architecture, data flow, components, sequence diagrams | You want the big picture |
| [`03-security.md`](./03-security.md) | Trust boundaries, the single app token, API-level enforcement, the MCP safety boundary | Before writing any networked/tool code |
| [`04-implementation-plan.md`](./04-implementation-plan.md) | Phased milestones, task breakdown, acceptance criteria | You're about to build |
| [`05-mcp-and-cursor-agent.md`](./05-mcp-and-cursor-agent.md) | MCP tool contracts and the `cursor-agent` CLI integration (flags, JSON, sessions, the pty question) | Implementing the executor layer |
| [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) | WebRTC audio, ephemeral tokens, push-to-talk toggle, "cursor start/end" voice control, tool-call routing | Implementing the phone/voice layer |
| [`07-data-and-deployment.md`](./07-data-and-deployment.md) | State/SQLite schema, project registry, Tailscale, systemd, env config | Persistence and shipping |
| [`08-decisions-and-risks.md`](./08-decisions-and-risks.md) | Decision log (ADR-style) capturing confirmed choices + remaining open risks | You're unsure why something is the way it is |
| [`09-competitive-landscape.md`](./09-competitive-landscape.md) | Similar OSS/commercial projects, duplication analysis, open source vs commercial recommendation | Evaluating whether to build, fork, buy, or open source |
| [`10-cursor-cli-reference.md`](./10-cursor-cli-reference.md) | Full Cursor CLI reference for everything useful to this project — commands, flags, output formats, model IDs, permissions | Implementing or debugging any CLI interaction |
| [`11-mcp-tool-surface.md`](./11-mcp-tool-surface.md) | Complete MCP tool inventory (18 tools, 8 groups) — full args, returns, ACP/CLI backing, what was excluded and why, source module layout | Implementing the MCP server |
| [`12-stream-json-watcher.md`](./12-stream-json-watcher.md) | Stream-JSON watcher & monitoring engine — NDJSON event classification, NarrationEvent cadence, narrator injection into realtime session, mid-run progress for Dad | Implementing the executor + narrator |
| [`13-voice-providers.md`](./13-voice-providers.md) | Multi-provider voice config — catalog, `.env` viability, `config.json` preferences, Settings API | Configuring OpenAI / Gemini / Anthropic / Bedrock |
| [`14-prompts.md`](./14-prompts.md) | Voice system prompts — `prompts/` folder, manifest, markdown editing, blind-accessibility persona | Tuning what the voice model says and how it behaves |
| [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) | Intelligence-first cascade (STT→Claude→TTS), workflow config, `/ws/intelligence` protocol | Default workflow — reasoning over audio naturalness |

## One-paragraph summary

The **phone** (iPhone Safari PWA) captures audio and talks **directly to the
speech-to-speech provider over WebRTC** using a short-lived ephemeral token
minted by the **bridge**. The provider transcribes, reasons, and emits tool
calls. Tool calls are routed back through the phone's data channel to the
**bridge** over an authenticated WebSocket; the bridge is the *sole executor* and
exposes only a small, constrained **MCP tool surface** (`cursor_submit`,
`cursor_status`, etc.). Those tools invoke **`cursor-agent`** non-interactively
against an **allowlisted project**, parse its JSON output, persist resume
session IDs, and return structured results that the model speaks back. Network
is private via **Tailscale**; mic-required HTTPS is provided by `tailscale serve`.
Every request crossing into the bridge is validated against a **single app
token** — security is enforced at the API level, not just the network layer.

**Default workflow (v0.3+):** **`cursor_native`** — WebKit STT/TTS on the phone,
utterances queued for **Cursor IDE** via the cursor-voice MCP server (`next_voice_turn` /
`speak` / `done`). Cursor is the reasoning layer with full project context. See
[`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md).

**Alternate workflows:** **`llm_intelligence`** (Claude on Bedrock orchestrator) and legacy
**`s2s_voice`** (OpenAI WebRTC / Nova Sonic) remain available via `settings.workflow.default`.
S2S provider settings are hidden in the UI unless `s2s_voice` is active.

## Confirmed key decisions (see `08` for full log)

- **Audio transport:** Direct **WebRTC** phone → provider (lowest latency).
- **Provider:** **OpenAI Realtime (GA)** as primary, behind a swappable provider
  interface; **Gemini Live** documented as the multilingual alternative.
  Both handle **Polish + English**.
- **Trigger:** **Latching push-to-talk** toggle (tap on / tap off) + in-session
  **"cursor end"** voice stop; **"cursor start"** voice activation documented as
  an optional always-listening enhancement. The **"Cursor…" prefix** marks
  utterances directed at the agent.
- **Safety:** The **constrained MCP tool set is the safety boundary** (not raw
  shell). Project **allowlist** + **git-based revert** are the guardrails.
- **Auth:** **Single user**, with an **app-level shared secret** enforced on
  every WebSocket + MCP request, layered on top of Tailscale.
