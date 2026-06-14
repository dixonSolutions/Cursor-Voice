# Cursor Voice

Self-hosted voice bridge for driving [Cursor's coding agent](https://cursor.com/docs/cli)
(`cursor-agent`) by **speech, from your phone**.

Speak to a coding agent from an iPhone (push-to-talk, with a "Cursor…" prefix); a
speech-to-speech model drafts and refines the request, asks clarifying questions,
and calls a small, constrained set of tools that run `cursor-agent` against your
own projects on your own machine. Audio goes phone ↔ provider over WebRTC;
networking is private over Tailscale; secrets stay on the host.

> **Status: planning / pre-implementation.** This repository currently contains
> the design and implementation docs. No application code yet — the architecture,
> security model, and phased plan are finalized first (see [`docs/`](./docs)).

## Why

A non-technical person (the original motivation: a parent) can direct real coding
work by voice, while the system stays safe: the voice model can only do what a
handful of constrained tools allow, every project path is operator-allowlisted,
and edits are git-revertable.

## How it works (high level)

```
iPhone (Safari PWA) ──WebRTC audio──► Speech-to-speech model (OpenAI Realtime / Gemini Live)
        │                                      │ tool calls (data channel)
        │ authenticated WSS (app token)        ▼
        └──────────────────────────────► Bridge (Node/TS, systemd)
                                               │ constrained MCP tools (the safety boundary)
                                               ▼
                                          cursor-agent  ──►  allowlisted project workspaces ──► git
```

- **Phone PWA** — mic capture, playback, push-to-talk; relays tool calls.
- **Bridge** — serves the app, mints ephemeral provider tokens, hosts the MCP
  tool layer, executes `cursor-agent`, persists state.
- **MCP tools** — `cursor_submit`, `cursor_status`, `cursor_stop`,
  `cursor_revert`, `cursor_diff`, `cursor_new_session`, `cursor_list_projects`,
  `cursor_set_project` — the only things the voice model can do.
- **Network** — Tailscale mesh + `tailscale serve` for the HTTPS required by
  mobile mic access. No port forwarding.

## Documentation

Full design lives in [`docs/`](./docs):

| Doc | Topic |
| --- | --- |
| [`docs/README.md`](./docs/README.md) | Index + one-paragraph summary |
| [`01-critical-analysis.md`](./docs/01-critical-analysis.md) | Feasibility critique |
| [`02-architecture.md`](./docs/02-architecture.md) | System architecture & data flow |
| [`03-security.md`](./docs/03-security.md) | Trust boundaries & API-level enforcement |
| [`04-implementation-plan.md`](./docs/04-implementation-plan.md) | Phased milestones |
| [`05-mcp-and-cursor-agent.md`](./docs/05-mcp-and-cursor-agent.md) | MCP tools & CLI integration |
| [`06-voice-audio-webrtc.md`](./docs/06-voice-audio-webrtc.md) | Voice, WebRTC, project selection |
| [`07-data-and-deployment.md`](./docs/07-data-and-deployment.md) | Config, state, deployment |
| [`08-decisions-and-risks.md`](./docs/08-decisions-and-risks.md) | Decision log & risks |
| [`09-competitive-landscape.md`](./docs/09-competitive-landscape.md) | Similar projects & OSS-vs-commercial |

## Planned stack

- **Bridge:** Node.js 20+, TypeScript, Fastify, `@modelcontextprotocol/sdk`,
  `better-sqlite3`, `simple-git`
- **Voice:** OpenAI Realtime (GA) primary, Gemini Live alternative, behind a
  swappable provider interface
- **Web app:** vanilla TypeScript + Vite (PWA)
- **Executor:** `cursor-agent` CLI (non-interactive, `--output-format stream-json`)
- **Network/deploy:** Tailscale, systemd

## Configuration model

- **`.env`** — secrets only (provider API key, app token). Never committed.
- **`config.json`** — non-secret settings + the allowlisted project registry.
  Projects are registered manually by the host operator.

See [`docs/07-data-and-deployment.md`](./docs/07-data-and-deployment.md).

## Security

Security is enforced at the API level, not just the network. A single app token
gates every request, the MCP tool surface bounds what the agent can do, project
paths come only from an operator-controlled allowlist, and git revert is the undo.
See [`docs/03-security.md`](./docs/03-security.md).

## Status & roadmap

Pre-build. Next step is Milestone 0 de-risking spikes (notably: confirm
`cursor-agent` runs cleanly without a pty, and validate the WebRTC + ephemeral
token loop). See [`docs/04-implementation-plan.md`](./docs/04-implementation-plan.md).
