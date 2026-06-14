# 04 — Implementation Plan

Phased, dependency-ordered, each milestone independently testable. The ordering
front-loads the two biggest risks (the `cursor-agent` non-TTY spike and the
WebRTC voice loop) so we fail fast on anything that would invalidate the design.

> Estimates are rough effort sizes (S ≈ <½ day, M ≈ ~1 day, L ≈ 2–3 days) for one
> developer, assuming accounts/keys are available.

## Milestone 0 — De-risking spikes (do these first)

| Task | Size | Acceptance |
| --- | --- | --- |
| **Spike A — cursor-agent without pty.** Run `cursor-agent -p --output-format stream-json --workspace <dir> --force --trust "<prompt>"` via plain `child_process.spawn`. | M | Clean NDJSON + final JSON object captured with no TTY. **Records the node-pty decision in `08`.** |
| **Spike B — resume continuity.** Run twice with persisted `--resume <id>`; confirm context carries over; `agent ls` lists it. | S | Second run remembers first. |
| **Spike C — WebRTC + ephemeral token round-trip.** Bridge mints token; a throwaway page connects via WebRTC; you can speak and hear a reply. | M | Two-way audio works from iPhone Safari over the Tailscale HTTPS origin. |
| **Spike D — function calling over WebRTC.** Define one dummy tool; confirm the data-channel function-call event arrives and `function_call_output` round-trips. | M | Dummy tool call observed end-to-end. |

**Gate:** all four green before building the real system. If A fails, add
`node-pty` (parsing unchanged). If C/D reveal provider quirks, adjust the
provider adapter before committing.

## Milestone 1 — Bridge skeleton + security

| Task | Size |
| --- | --- |
| Project scaffold (TS, tsup, eslint/prettier, Vite for `web/`). | S |
| `config.ts` (zod-validated env), `log.ts` (structured + audit). | S |
| Fastify server: static serving + `/healthz`. | S |
| `auth.ts`: app-token middleware for HTTP + WS (constant-time, close on fail). | M |
| SQLite `db.ts` + migrations; `config.ts` loads `.env` (keys) + `config.json` (settings + projects); `registry.ts` reconciles registry from `config.json`. | M |

**Acceptance:** unauthorized requests rejected (401 / socket closed) at the API;
health endpoint green; registry loads and validates paths.

## Milestone 2 — Executor (cursor-agent integration)

| Task | Size |
| --- | --- |
| `cursorAgent.ts`: flag builder (from registry), spawn, `stream-json` parser, version self-check. | L |
| `sessions.ts`: persist/restore per-project resume id. | S |
| `git.ts`: `cursor_diff`, `cursor_revert` with pre-job checkpoint. | M |
| Job lifecycle: job rows, events, concurrency cap, timeout, stop/reap, startup orphan cleanup. | M |

**Acceptance:** can submit a prompt programmatically, see streamed progress,
get a final summary + diffstat, revert it, and stop a running job.

## Milestone 3 — MCP tool layer

| Task | Size |
| --- | --- |
| zod schemas in `schemas.ts` (single source of truth for all 16 tools). | M |
| MCP server wiring — register all 16 tools across 8 modules (see `11`). | M |
| **Project tools**: registry resolution, fuzzy match + `query` filter, sticky active project, disambiguation errors. | M |
| **Model tools**: `cursor-agent models` parse + SQLite cache + TTL refresh + filter. | M |
| **Session tools**: `cursor_new_session` (`create-chat`), `cursor_session_info` from DB. | S |
| **System tools**: `cursor_agent_info` / `cursor_agent_status` (`about/status --format json`). | S |
| **MCP inspect tools**: `cursor_mcp_list`, `cursor_mcp_tools` (parse plain-text output). | S |
| `cursor_ask` (hard-coded `--mode ask`) + `preRunFlags` from config for all invocations. | S |
| HTTP project endpoints: `GET /api/projects` (names+descriptions, no paths) + `POST /api/active-project`. | S |
| Server-side arg validation + project allowlist enforcement + audit logging on all tools. | M |
| `functionTools.ts` — generate provider function-tool definitions from the same zod schemas. | S |

**Acceptance:** each tool callable via MCP; invalid/foreign-project args rejected
and audited; function-tool definitions generated.

## Milestone 4 — Voice provider + token + relay

| Task | Size |
| --- | --- |
| `provider.ts` interface; OpenAI Realtime (GA) implementation. | L |
| `token.ts`: mint ephemeral tokens with session+tool config baked in. | M |
| Control WS: receive forwarded tool calls, dispatch handlers, return results. | M |
| System prompt: "Cursor…" prefix, clarifying questions, progress narration, Polish/English, "cursor end". | M |
| Async-function-calling + job/poll support for long jobs. | M |

**Acceptance:** spoken command → clarifying question (if needed) → tool call →
agent runs → spoken summary, end to end, with the key never leaving the bridge.

## Milestone 5 — PWA

| Task | Size |
| --- | --- |
| UI: large push-to-talk toggle, status, transcript log, connection indicator (UX-law-aligned). | M |
| **Project dropdown**: load `GET /api/projects`, manual select → `POST /api/active-project`, active-project badge synced with voice selection. | M |
| `webrtc.ts`: peer connection, data channel, tool-call relay, AudioContext unlock. | L |
| Latching toggle + "cursor start/end" handling; iOS interruption recovery. | M |
| PWA manifest/icons; token entry + storage. | S |

**Acceptance:** add-to-Home-Screen app; tap to talk; full loop works on dad's
iPhone over Tailscale.

## Milestone 6 — Deployment & hardening

| Task | Size |
| --- | --- |
| systemd unit (dedicated user, sandbox dirs), `tailscale serve` setup. | M |
| `.env` hygiene, log rotation, backups. | S |
| Health/monitoring; graceful agent-crash handling. | S |
| Docs: runbook + project-naming guidance with the user. | S |

**Acceptance:** survives reboot, auto-restarts, logs are useful, dad can use it
unattended.

## Milestone 7 — UX polish & optional enhancements

| Task | Size |
| --- | --- |
| Plan-mode-first toggle for `cursor_submit` (confirm before apply). | M |
| Better progress narration / earcons; error recovery phrasing (Peak-End). | M |
| **(Optional v2)** on-device "cursor start" wake-word spotter. | L |
| **(Optional)** Gemini Live provider implementation behind the interface. | M |

## Testing strategy

- **Unit:** flag builder, parser (fixtures of `stream-json`), arg validation,
  auth, registry resolution.
- **Integration:** executor against a scratch git repo; revert correctness.
- **Contract:** tool schema ↔ function-tool generation stays in sync.
- **Manual/E2E:** the voice loop on the actual iPhone (the only real test of
  latency + STT of Polish/English + "Cursor…" prefix discipline).
- **Linting/build gate:** run lint + typecheck before each milestone closes
  (per project rule).

## Suggested cutline for a first usable version (MVP)

Milestones 0–5 with: push-to-talk toggle, `cursor_submit` + `cursor_status` +
`cursor_revert` + `cursor_diff`, `cursor_set_project`/`cursor_list_projects` with
sticky active project (even a 1–2 project registry exercises the selection flow),
OpenAI provider, English+Polish. Defer `cursor_new_session`, plan-mode toggle,
and the v2 wake-word to later.
