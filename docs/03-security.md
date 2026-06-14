# 03 — Security Model

> Project rule: **security must be enforced at the API level** — not merely
> filtered/disabled in the frontend. Every control below is enforced server-side
> on the bridge.

## Trust boundaries

| Boundary | Trusted? | Enforcement |
| --- | --- | --- |
| Tailnet network | Partially | Tailscale ACLs; device must be on the tailnet |
| Phone PWA → bridge | **Not trusted** | App token required on every HTTP + WS message; args re-validated |
| Phone → provider (WebRTC) | n/a (audio) | Ephemeral token only; no API key on device |
| Provider → tools | Constrained | Only the 6 MCP tools; provider can't reach the bridge directly (default design) |
| Bridge → cursor-agent | Controlled | Fixed flags + `--workspace` from allowlist registry |
| cursor-agent → filesystem | Bounded | Only allowlisted project workspaces; git revert as undo |

**Do not rely on Tailscale alone.** Tailscale is network-layer auth; we *also*
require an application-layer secret so that a compromised/misconfigured tailnet
device cannot drive the agent.

## The single app token

- A high-entropy shared secret (e.g., 32 random bytes, base64url) stored in
  `.env` on the bridge and entered once into the PWA (saved to
  `localStorage`/Home-Screen app).
- Sent as `Authorization: Bearer <token>` on every `/api/*` request and as the
  first message (or `Sec-WebSocket-Protocol`/query param validated server-side)
  on the control WebSocket.
- **Verified on the server for every request and every WS frame** that triggers
  an action. Constant-time comparison. No token → 401 and the socket is closed.
- Rotatable by changing `.env` + re-pasting in the PWA.

> Single-user scope (confirmed). If multi-user is ever needed, replace the shared
> secret with per-user tokens + an identity column on sessions (see `07`).

## The MCP layer is the safety boundary

This is the core safety design (per your guidance: *"this is an MCP wrapper, it
is not unlimited shell access"*). The voice model's entire capability is the
small, fixed tool set (the project tools + the execute/status/git tools). It
**cannot** run arbitrary shell, read arbitrary files, or point the agent at
arbitrary paths.

Enforcement per tool call:

1. **AuthN** — valid app token, else reject.
2. **Tool allowlist** — only the registered tools are dispatchable.
3. **Schema validation** — args validated against zod schemas; unknown/extra
   fields rejected; types coerced safely.
4. **Project allowlist (registry)** — `project` must resolve to a known entry in
   the project registry. The workspace path passed to `cursor-agent` comes from
   the **registry**, never from the caller. No path traversal, no arbitrary dirs.
5. **Fixed flag construction** — flags are assembled in code, not interpolated
   from model output. The only model-controlled value reaching the CLI is the
   **prompt string**, passed as a single argv element (no shell string
   interpolation; spawn with an args array, `shell: false`).
6. **Audit** — every tool call (who/what/when/project/result) written to the
   SQLite audit log.

### Project endpoints leak no paths

The web-app dropdown and voice agent both choose from the registry, but neither
ever receives filesystem paths:

- `GET /api/projects` returns **names + descriptions (+ aliases) only** — never
  `path`. The frontend list is a convenience, not an authority.
- `POST /api/active-project` and every tool accept a **name**; the bridge
  resolves it to a path via the registry server-side.
- The registry itself is **operator-controlled** (`config.json`, edited over SSH)
  — dad/voice can *select* projects but can never *register* or repath them.
- Secrets are isolated in `.env` (keys only); settings + project list live in
  non-secret `config.json` (see `07`).

### Why the prompt string is acceptable model-controlled input

`cursor-agent` interprets the prompt as a task, not as host shell. We never build
a shell command from it (`shell: false`, args array). The agent's own actions are
bounded by the workspace and recoverable via git. Optional hardening:
`--sandbox enabled` and/or **plan-mode-first** (`--mode plan`) so `cursor_submit`
returns a *proposed plan* the model can confirm with the user before a second
apply call.

## Rejected alternative: remote-MCP-by-URL

The GA Realtime API can call a remote MCP server **by URL** (provider's servers →
your MCP endpoint), which would keep tool calls off the phone entirely. We
**reject this as the default** because it requires exposing the bridge's MCP
endpoint to the public internet (Tailscale **Funnel**), enlarging the attack
surface of a home machine. The chosen design keeps the bridge reachable **only**
from the tailnet, with the authenticated phone as the relay. (If ultra-low
tool-call latency ever justifies it, it can be enabled behind Funnel + a
per-request secret header + IP allowlisting — documented as an opt-in, not the
default.)

## cursor-agent execution hardening

- Run as a **dedicated, least-privileged OS user** that only owns the project
  workspaces — not as root, not as your primary user.
- `spawn(cmd, argsArray, { shell: false, cwd: registryPath })`.
- Resource guards: per-job timeout, max concurrent jobs, kill-on-stop
  (`cursor_stop`), reap zombies.
- `--trust` is scoped to the allowlisted workspace only.
- Pin the CLI version; the CLI is beta and flags may change.

## Secrets & data hygiene

- `.env` perms `600`, owned by the service user, **never committed** (`.env` in
  `.gitignore`; commit `.env.example`).
- Provider API key lives **only** on the bridge; the browser receives ephemeral
  tokens with the shortest viable TTL.
- Don't log full prompts/results at info level if they may contain sensitive
  project content; audit log is access-controlled on the host.
- TLS: provided by `tailscale serve`; no self-signed cert handling in app code.

## Threat checklist (quick)

| Threat | Mitigation |
| --- | --- |
| Stolen tailnet device | App token still required + token rotation |
| Token leak | Rotate via `.env`; short ephemeral provider TTL limits provider abuse |
| Path traversal / arbitrary workspace | Registry allowlist; path from registry only |
| Shell injection via prompt | `shell:false` + args array; prompt is a task, not a command |
| Destructive but valid agent action | `cursor_revert` (git); optional plan-mode-first |
| Runaway/zombie agent process | Timeouts, concurrency cap, `cursor_stop`, reaping |
| Public exposure | No Funnel by default; tailnet-only |
