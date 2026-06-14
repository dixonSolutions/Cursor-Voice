# 10 — Cursor CLI Reference (useful surface for Cursor Voice)

Verified against the live CLI (June 2026). The CLI is **beta** — flags and
output may change between releases. All CLI interaction in the bridge is isolated
in `src/executor/cursorAgent.ts` so regressions are a one-file fix.

> `cursor-agent` is the binary name on PATH after install. `agent` is an alias.

---

## Commands used by Cursor Voice

### `cursor-agent models`

Lists every model available to the authenticated account.

```bash
cursor-agent models
# or
cursor-agent --list-models
```

**Output:** plain text, one line per model, format `<id> - <display name>`.
Approximately 140+ models (verified on this account, June 2026). There is **no
native filter flag** — filtering is done by the bridge (the `cursor_list_models`
MCP tool parses and filters this output server-side).

```
auto - Auto
composer-2.5-fast - Composer 2.5 Fast (default)
gpt-5.2 - GPT-5.2
claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking
...
Tip: use --model <id> (or /model <id> in interactive mode) to switch.
```

**Parsing:** strip the last `Tip:` line and the header `Available models` line;
split each remaining line at ` - ` into `{ id, displayName }`. No JSON output
available for this command — parse manually.

**Known issue (community-reported May 2026):** `--model` suffix for thinking
level is sometimes silently ignored after CLI updates, resetting to medium/default
thinking. Keep the model ID as the version-pinned parameter; test after updates.

---

### `cursor-agent -p` (print / headless mode)

```bash
cursor-agent -p [flags] "prompt"
```

The non-interactive execution path. All Cursor Voice executor calls use this.

| Flag | Description |
| --- | --- |
| `-p, --print` | Required for headless. Enables stdout output + all tools (incl. write/shell). |
| `--output-format text\|json\|stream-json` | `stream-json` preferred (NDJSON; events during run). `json` is single object at completion. `text` is final message only. |
| `--stream-partial-output` | With `stream-json`: char-level deltas (probably not needed for voice; add only if you need live typing). |
| `--model <id>` | Model ID from `cursor-agent models`. Set per-job; no hardcoding in config. |
| `--workspace <dir>` | **Always set** from registry. Scopes both edits and session history. |
| `--force` / `--yolo` | Auto-run + apply changes. Still respects `deny` list in permissions config. |
| `--trust` | Skips workspace-trust prompt (headless only). |
| `--sandbox enabled\|disabled` | OS-level filesystem/network boundaries; non-sandboxable commands fail silently. |
| `--resume [id]` | Resume a session (workspace-scoped). Must pair with the **same `--workspace`**. |
| `--continue` | Resume the most recent session in the workspace (alias for `--resume=-1`). |
| `--mode plan\|ask` | `agent` is default. `ask` = read-only (no writes). `plan` = emit plan + questions, no edits. |
| `--approve-mcps` | Auto-approve MCP servers the agent itself uses (not Cursor Voice's MCP server). |

---

### `cursor-agent ls`

Lists **chat sessions scoped to a workspace**. Default scope = cwd.

```bash
cursor-agent ls --workspace /path/to/project
```

- Returns sessions for that workspace only (not global, not cross-project).
- Always pass `--workspace` when checking a specific project's sessions.
- Use for **manual recovery** of a lost resume ID; not for project discovery.

---

### `cursor-agent resume` / `--resume` / `--continue`

```bash
cursor-agent --resume <id>         # resume specific session
cursor-agent --continue            # resume most recent in cwd
cursor-agent resume                # interactive resume of latest
```

- Sessions are **workspace-scoped**: resuming with a different `--workspace`
  than the session was created under silently starts fresh.
- The bridge **always** pairs `--resume <id>` with the same `--workspace` the
  session originated from (both stored per project in the registry).

---

### `cursor-agent status` (whoami)

```bash
cursor-agent status
```

Shows authenticated account (email, user ID). Useful in the health check to
confirm the service user is logged in.

---

### `cursor-agent about`

```bash
cursor-agent about
```

Emits version, system info, and account. Parse the version for startup logging
and the health endpoint.

---

### `cursor-agent mcp` subcommands

Manage MCP server configurations (these operate on Cursor's own `.cursor/mcp.json`,
not Cursor Voice's bridge MCP server):

```bash
cursor-agent mcp list                    # list configured MCP servers + status
cursor-agent mcp list-tools <server>     # list tools for a specific server
cursor-agent mcp enable <server>
cursor-agent mcp disable <server>
cursor-agent mcp login <server>
```

---

### `cursor-agent create-chat`

```bash
cursor-agent create-chat
```

Creates a new empty chat and returns its ID. Useful for **pre-creating a session
ID** before submitting the first prompt (alternative to extracting it from the
first run's output). Potential use in `cursor_new_session` to get a clean ID up
front.

---

## Permissions config (`cli-config.json`)

Location:
- Global (service user): `~/.cursor/cli-config.json`
- Project-level (only `permissions` key honoured): `<workspace>/.cursor/cli.json`

```json
{
  "version": 1,
  "permissions": {
    "allow": ["Shell(ls)", "Shell(git)", "WebFetch(docs.github.com)"],
    "deny":  ["Shell(rm)", "Shell(sudo)", "Shell(git:push*)",
              "Read(.env*)", "Write(**/*.key)", "Write(**/*.pem)"]
  }
}
```

Token types: `Shell(<cmd>)`, `Read(<glob>)`, `Write(<glob>)`,
`WebFetch(<domain>)`, `Mcp(<server>:<tool>)`. Deny beats allow. Glob patterns
support `**`, `*`, `?`.

`--force` (`--yolo`) = auto-run BUT **still honours the deny list**.
Without `--force`: non-allowlisted commands silently denied (agent adapts, no
dialog). **Neither path pops an interactive prompt in headless mode.**

---

## Output formats (`--output-format`)

### `stream-json` (NDJSON — preferred for Cursor Voice)

One JSON object per line, emitted as the run progresses.

```jsonc
// system init
{"type":"system","subtype":"init","session_id":"...","model":"..."}

// tool call start
{"type":"assistant","subtype":"tool_use_start","tool_call":{"writeToolCall":{"path":"src/app.ts"}}}

// tool call done
{"type":"assistant","subtype":"tool_use_done","tool_call":{...},"success":true}

// final assistant message (aggregated between tool calls)
{"type":"assistant","message":{"content":[{"text":"Done. Added dark mode toggle..."}]}}

// run complete
{"type":"result","session_id":"...","usage":{...}}
```

Key fields:
- `session_id` — appears on `system:init` and `result`; persist as `resume_id`.
- Tool call events (`tool_use_start`/`tool_use_done`) → use for progress narration.
- `thinking` events are **suppressed** in print mode.
- Ignore unknown fields (forward-compatible).
- Buffer lines until `\n`; run `strip-ansi` defensively before `JSON.parse`.

### `json` (single object at completion)

Emits one JSON object when the run completes. No intermediate events — worse for
voice progress narration but simpler for `cursor_ask` (read-only, one-shot).

### `text` (final message only)

Human-readable final assistant message. No structure; avoid for programmatic use.

---

## `stream-json` event type cheat sheet

| `type` | `subtype` | Meaning |
| --- | --- | --- |
| `system` | `init` | Run started; contains `session_id`, `model` |
| `assistant` | `tool_use_start` | Tool call beginning (path/url in `tool_call`) |
| `assistant` | `tool_use_done` | Tool call complete; `success: bool` |
| `assistant` | _(none)_ | Aggregated assistant message text |
| `result` | | Run finished; contains `session_id`, `usage` |
| `error` | | Run failed |

---

## Model ID conventions (observed, June 2026)

Naming pattern: `<family>-<version>-[<variant>-]<effort>[-fast]`

| Segment | Examples |
| --- | --- |
| Family | `claude`, `gpt`, `gemini`, `grok`, `kimi`, `composer` |
| Version | `4.8`, `5.2`, `5.3`, `3.1` |
| Variant | `opus`, `sonnet`, `fable`, `codex`, `mini`, `nano` |
| Effort | `low`, `medium` (often omitted), `high`, `xhigh`, `max` |
| Thinking | insert `thinking-` before effort: `thinking-high` |
| Fast | suffix `-fast` = faster/cheaper variant of same capability |

Special values:
- `auto` — Cursor chooses automatically.
- `composer-2.5-fast` — the current account default (marked `(default)` in output).

**No hardcoded model IDs in Cursor Voice config** — models are fetched live via
`cursor_list_models` and selected per-request via `cursor_set_model`. The bridge
caches the model list (TTL configurable) to avoid running `cursor-agent models`
on every request.

---

## Other useful CLI facts

- **`CURSOR_API_KEY` env var** — alternative to `--api-key`; set for the service
  user if needed.
- **`--worktree`** — runs agent in a fresh git worktree under `~/.cursor/worktrees`.
  Potential use for isolated experiments without touching the working tree.
- **Cloud handoff (`&` prefix or `-c`)** — delegates to Cursor cloud mid-session.
  Out of scope for Cursor Voice (local machine is the target).
- **`/max-mode [on|off]`** — toggles Max Mode in interactive mode only.
- **`agent update`** — updates the CLI. Run manually; **pin the version** in
  production (the bridge logs it on startup via `cursor-agent about`).
- **Sessions are workspace-scoped** — `agent ls` and `--resume` are scoped to
  `--workspace` (or cwd). Moving a project directory breaks the session link.
- **Non-TTY detection** — print mode is inferred for piped stdin or non-TTY
  stdout; `-p` is explicit and always safe to include.

---

## Full command reference (summary)

| Command | Cursor Voice use |
| --- | --- |
| `cursor-agent models` | `cursor_list_models` — parse and cache |
| `cursor-agent -p --output-format stream-json ...` | `cursor_submit`, `cursor_ask` |
| `cursor-agent ls --workspace <path>` | Manual session recovery |
| `cursor-agent --resume <id> --workspace <path>` | Session continuity (via `cursor_submit`) |
| `cursor-agent create-chat` | Optional: pre-create session for `cursor_new_session` |
| `cursor-agent status` | Health check: confirm authenticated |
| `cursor-agent about` | Health check: log version |
| `cursor-agent mcp list` | Debugging: confirm executor's own MCPs |
| `cursor-agent update` | Manual only; never auto-update the service |
