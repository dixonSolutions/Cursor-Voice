# 11 — Complete MCP Tool Surface

All tools exposed by the Cursor Voice bridge MCP server. Organised into groups.
Every tool is defined once in zod — the same schema emits both the MCP
registration and the provider function-tool definition (DRY).

Verified against the live CLI (`cursor-agent 2026.06.04-5fd875e`, June 2026).

---

## Tool groups

| Group | Tools | Source |
| --- | --- | --- |
| **Project** | `cursor_list_projects`, `cursor_set_project` | Custom (registry) |
| **Model** | `cursor_list_models`, `cursor_set_model` | CLI: `cursor-agent models` |
| **Execute** | `cursor_submit`, `cursor_ask` | CLI: `-p --output-format stream-json/json` |
| **Job** | `cursor_status`, `cursor_stop` | Bridge state (DB) |
| **Session** | `cursor_new_session`, `cursor_session_info` | CLI: `create-chat`, registry |
| **Git** | `cursor_diff`, `cursor_revert` | `simple-git` |
| **System** | `cursor_agent_info`, `cursor_agent_status` | CLI: `about --format json`, `status --format json` |
| **MCP inspect** | `cursor_mcp_list`, `cursor_mcp_tools` | CLI: `mcp list`, `mcp list-tools` |

---

## Group: Project (custom — registry)

### `cursor_list_projects`
```
args:  { query?: string }
returns: { projects: [{ name, description, aliases, enabled, active }] }
```
Lists all enabled projects from the `config.json` registry. Optional `query`
filters server-side (fuzzy contains on `name`, `aliases`, `description`).
Used for discovery ("what can I work on?"), search, and disambiguation.
The web-app dropdown uses `GET /api/projects` (same data, REST version).

### `cursor_set_project`
```
args:  { project: string }
returns: { active_project, description, path_hash }  // never the real path
```
Sets the sticky active project for the session. Validates `project` against the
registry. The bridge speaks the project description back ("now working on
**budget** — the finance tracker") so a mishear is caught before any edits.
Also available via `POST /api/active-project` from the web-app dropdown.

---

## Group: Model (CLI: `cursor-agent models`)

### `cursor_list_models`
```
args:  { query?: string }
returns: { models: [{ id, displayName }], active_model, cached_at }
```
Returns all models from the cached `model_cache` table (populated by
`cursor-agent models` on startup and on TTL expiry). Optional `query` filters by
case-insensitive contains on `id` or `displayName` ("claude", "thinking",
"fast", etc.). Refreshes cache automatically on TTL miss.

> **CLI note:** `cursor-agent models` (or `--list-models`) outputs plain text,
> one line per model, format `<id> - <displayName>`. No JSON output available.
> No native filter flag — bridge parses and filters in-process.
> The tip line (`Tip: use --model ...`) and header (`Available models`) are stripped.

### `cursor_set_model`
```
args:  { model_id: string }
returns: { active_model, displayName }
```
Sets `session_state.active_model`. Validated against the model cache (must be a
known ID). Default session value is `"auto"` (Cursor uses the account default).
Fuzzy-match on displayName is done before the tool is called (by the voice model
from `cursor_list_models` results); the tool receives the exact ID.

---

## Group: Execute (CLI: `cursor-agent -p`)

### `cursor_submit`
```
args:  { prompt: string, project?: string, mode?: "agent" | "plan" }
returns: { job_id, session_id, status, project, model }
```
Submits work to cursor-agent. Returns immediately with a `job_id`; track
progress via `cursor_status`. Applies `session_state.active_project`,
`session_state.active_model`, and `config.preRunFlags`. Resumes the project's
existing session via `--resume` if a `resume_id` is stored.

CLI equivalent:
```
cursor-agent -p --output-format stream-json
  --workspace <registry path>
  --model <session.active_model>
  --resume <project.resume_id>    # if set
  [--mode plan]
  --force --trust                 # from preRunFlags
  "<prompt>"
```

> **Note:** Prompt text is prepended with the standing instruction to proceed
> without asking questions (steering, not a flag). See `05`.

### `cursor_ask`
```
args:  { question: string, project?: string }
returns: { answer: string }
```
Read-only repo Q&A. Hard-coded `--mode ask` — cannot write or run mutating
commands regardless of `preRunFlags`. One-shot (no `--resume`); does not pollute
the work session. The voice model's **only** route to repo facts.

CLI equivalent:
```
cursor-agent -p --output-format json
  --workspace <registry path>
  --model <session.active_model>
  --mode ask
  --force --trust                 # harmless in ask mode
  "<question>"
```

---

## Group: Job (bridge state — SQLite)

### `cursor_status`
```
args:  { job_id: string }
returns: { status, progress: [{ ts, kind, text }], summary?, diffstat?, session_id, project, model }
```
Poll a running or completed job. `status ∈ running | done | error | stopped`.
Progress is the streamed event log. Used for voice narration ("still working…")
and final result retrieval.

### `cursor_stop`
```
args:  { job_id: string }
returns: { status: "stopped" }
```
SIGTERM → SIGKILL the cursor-agent process for a job. Updates job status.

---

## Group: Session (CLI: `create-chat` + registry)

### `cursor_new_session`
```
args:  { project?: string }
returns: { session_id, project }
```
Clears the project's stored `resume_id` so the next `cursor_submit` starts a
fresh thread. Optionally calls `cursor-agent create-chat` to pre-create a session
ID before any prompt.

> **CLI note:** `cursor-agent ls` requires an interactive TTY (raw mode) and
> **cannot be used headlessly**. Session IDs are captured from `cursor_submit`
> output (the `session_id` field on `system:init` and `result` events) and
> persisted to the registry — the bridge is the source of truth for resume IDs.

### `cursor_session_info`
```
args:  { project?: string }
returns: { project, resume_id, last_job_id, last_run_at }
```
Read the persisted session state for a project — useful for the voice model to
narrate "you were last working on budget 20 minutes ago" without running the CLI.

---

## Group: Git (`simple-git`)

### `cursor_diff`
```
args:  { project?: string, full_patch?: boolean }
returns: { diffstat: string, patch?: string, clean: boolean }
```
Current uncommitted diff for the project workspace. `diffstat` is always
returned (file summary); `full_patch` also returns the raw diff text. Used by the
voice model to describe what changed.

### `cursor_revert`
```
args:  { project?: string, confirm?: boolean }
returns: { reverted_to: string, files: string[], method: "stash" | "reset_hard" }
```
Git-level undo. Restores the pre-job checkpoint recorded by `cursor_submit`.
- Uncommitted changes → `git stash` (safe, reversible).
- Agent-committed changes → `git reset --hard <checkpoint>` (destructive;
  requires `confirm: true`).
The voice model asks for confirmation before calling with `confirm: true`.

---

## Group: System (CLI: `about`, `status`)

### `cursor_agent_info`
```
args:  (none)
returns: { cliVersion, model, osPlatform, osArch, shell }
```
Wraps `cursor-agent about --format json`. Used in the health check and by the
voice model if dad asks "what version is Cursor?".

CLI output (JSON):
```json
{
  "cliVersion": "2026.06.04-5fd875e",
  "model": "Composer 2.5 Fast",
  "subscriptionTier": null,
  "osPlatform": "linux",
  "osArch": "x64",
  "userEmail": null
}
```

### `cursor_agent_status`
```
args:  (none)
returns: { authenticated, email?, firstName? }
```
Wraps `cursor-agent status --format json`. Health check: confirm the service user
is authenticated before accepting jobs.

CLI output (JSON):
```json
{
  "status": "authenticated",
  "isAuthenticated": true,
  "userInfo": { "email": "...", "firstName": "..." }
}
```

---

## Group: MCP inspect (CLI: `mcp list`, `mcp list-tools`)

These are informational — useful for debugging the executor's own MCP config.

### `cursor_mcp_list`
```
args:  (none)
returns: { servers: [{ name, status }] }
```
Wraps `cursor-agent mcp list`. Lists MCP servers configured in
`.cursor/mcp.json` and their load status. Not related to Cursor Voice's own MCP
server — this is about MCPs the executor agent itself may use.

CLI output: plain text (`<name>: <status>`), parsed by the bridge.

### `cursor_mcp_tools`
```
args:  { server: string }
returns: { tools: [{ name, args }] }
```
Wraps `cursor-agent mcp list-tools <identifier>`. Lists tools for a given
executor MCP server. Informational; used for debugging.

---

## CLI commands NOT ported (and why)

| Command | Why not ported |
| --- | --- |
| `cursor-agent ls` | **Requires interactive TTY** (raw mode error headlessly). Session IDs are captured from `cursor_submit` output instead. |
| `cursor-agent resume` (interactive) | Interactive TTY only. Resume is handled by the bridge via `--resume` flag on `cursor_submit`. |
| `cursor-agent login` / `logout` | Operator-only setup via SSH/iSH; not part of the voice flow. |
| `cursor-agent update` | Never auto-update the service. Manual only. |
| `cursor-agent worker start` | Cloud worker feature; Cursor Voice uses local `cursor-agent -p`. |
| `cursor-agent generate-rule` | Interactive TTY only. |
| `cursor-agent install-shell-integration` | Setup only. |
| `cursor-agent acp` | Advanced hidden command for custom ACP clients; out of scope. |

---

## Complete tool inventory (all tools)

> **ACP note:** `cursor_submit`, `cursor_ask`, `cursor_stop`, `cursor_status`,
> `cursor_new_session`, `cursor_approve_plan`, and `cursor_answer_question` are
> backed by the **ACP protocol** (`cursor-agent acp`, JSON-RPC over stdio) in the
> production implementation. The `--print` path is retained as a fallback/spike.
> See [`12-acp-and-live-monitoring.md`](./12-acp-and-live-monitoring.md).

| # | Tool | Group | Backed by |
| --- | --- | --- | --- |
| 1 | `cursor_list_projects` | Project | Registry (custom) |
| 2 | `cursor_set_project` | Project | Registry (custom) |
| 3 | `cursor_list_models` | Model | CLI: `cursor-agent models` |
| 4 | `cursor_set_model` | Model | State (DB) |
| 5 | `cursor_submit` | Execute | ACP: `session/prompt` |
| 6 | `cursor_ask` | Execute | ACP: `session/prompt --mode ask` |
| 7 | `cursor_status` | Job | DB + ACP pending state |
| 8 | `cursor_stop` | Job | ACP: `session/cancel` |
| 9 | `cursor_new_session` | Session | ACP: `session/new` + `create-chat` |
| 10 | `cursor_session_info` | Session | DB |
| 11 | `cursor_diff` | Git | simple-git |
| 12 | `cursor_revert` | Git | simple-git |
| 13 | `cursor_agent_info` | System | CLI: `about --format json` |
| 14 | `cursor_agent_status` | System | CLI: `status --format json` |
| 15 | `cursor_mcp_list` | MCP inspect | CLI: `mcp list` |
| 16 | `cursor_mcp_tools` | MCP inspect | CLI: `mcp list-tools` |
| 17 | `cursor_answer_question` | Interaction | ACP: respond to `cursor/ask_question` |
| 18 | `cursor_approve_plan` | Interaction | ACP: respond to `cursor/create_plan` |

**18 tools total.** All defined from a single zod schema source; MCP and provider
function-tool definitions are generated from that schema (DRY).

---

## Source module layout

```
src/mcp/
├── tools/
│   ├── project.ts       # cursor_list_projects, cursor_set_project
│   ├── model.ts         # cursor_list_models, cursor_set_model
│   ├── execute.ts       # cursor_submit, cursor_ask
│   ├── job.ts           # cursor_status, cursor_stop
│   ├── session.ts       # cursor_new_session, cursor_session_info
│   ├── interaction.ts   # cursor_answer_question, cursor_approve_plan
│   ├── git.ts           # cursor_diff, cursor_revert
│   ├── system.ts        # cursor_agent_info, cursor_agent_status
│   └── mcpInspect.ts    # cursor_mcp_list, cursor_mcp_tools
├── schemas.ts           # all zod schemas (single source of truth)
├── server.ts            # MCP server wiring — registers all tools
├── handlers.ts          # dispatches by tool name → module
└── functionTools.ts     # generates provider function-tool defs from schemas

src/executor/
├── acp.ts               # ACP process: spawn, initialize, authenticate, reconnect
├── session.ts           # session/new, session/load, session/cancel
├── events.ts            # session/update, todos, tasks, permissions handler
├── questions.ts         # pending cursor/ask_question + cursor/create_plan state
├── cursorAgent.ts       # --print fallback path (Milestone 0 spike + compatibility)
└── git.ts               # simple-git: diff, revert, checkpoint
```
