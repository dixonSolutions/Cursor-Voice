# 05 — MCP Tools & cursor-agent Integration

This is the executor layer: the constrained tool surface and how it drives the
`cursor-agent` CLI. All CLI knowledge is isolated here so the (beta) CLI's churn
touches one module.

## Tool surface (single source of truth)

Define each tool **once** with a zod schema; emit both the MCP tool registration
and the provider function-tool definition from it (DRY). The model-controlled
inputs are intentionally minimal.

| Tool | Args | Returns | Notes |
| --- | --- | --- | --- |
| `cursor_list_projects` | `query?: string` | `{ projects: [{name, description, aliases, active}] }` | View/search the registry. No `query` → full list; `query` → server-side filtered (name/alias/description, fuzzy). Used for "what can I work on?", search ("anything about the website?"), and disambiguation read-back. |
| `cursor_set_project` | `project: string` | `{ active_project, description }` | Sets the **sticky active project** for the session. "Cursor, switch to the budget app." |
| `cursor_ask` | `question: string`, `project?: string` | `{ answer }` | **Read-only repo Q&A** (`--mode ask`). The voice model's *only* way to gain repo context — it has no direct repo access. Used to clarify *before* asking dad a question or drafting a `cursor_submit`. Cannot edit anything. |
| `cursor_submit` | `prompt: string`, `project?: string`, `mode?: "agent"\|"plan"\|"ask"` | `{ job_id, session_id, status, project }` | Starts (or resumes) work. `project` **optional** — defaults to the active project. Returns fast; long work tracked via `cursor_status`. |
| `cursor_status` | `job_id: string` | `{ status, progress[], summary?, diffstat?, session_id }` | Poll for progress/result. `status ∈ running\|done\|error\|stopped`. |
| `cursor_stop` | `job_id: string` | `{ status }` | Kills the running agent process for that job. |
| `cursor_revert` | `project?: string` | `{ reverted_to, files[] }` | Git-level undo. Defaults to active project. |
| `cursor_new_session` | `project?: string` | `{ session_id }` | Starts a fresh `cursor-agent` thread (drops resume id). Defaults to active project. |
| `cursor_diff` | `project?: string` | `{ diffstat, patch? }` | Current uncommitted diff for review/narration. Defaults to active project. |

### Project selection & resolution (server-side)

Project selection is the riskiest input in the whole system — a misheard name
could point the agent at the wrong codebase. The strategy is **liberal accept,
strict execute** (Postel's Law): the model maps fuzzy speech to a candidate, but
the bridge is the final authority and only ever runs against an allowlisted path.

1. **Catalog is injected into the session.** At token-mint time the bridge bakes
   the project catalog (canonical `name` + `aliases[]` + short `description`)
   into the realtime session config / system prompt. The model therefore *knows
   the valid options* and resolves "the budget thing" → `budget` itself.
2. **Sticky active project.** The session has one **active project** (stored
   server-side, see `07`). Once set, `project` can be omitted on every tool call
   — dad says it once, not every sentence (lowers cognitive load; Miller's Law).
3. **Server-side resolution + validation** for any `project` value received:
   - Normalize → match against `name` then `aliases` (case-insensitive).
   - If no exact match, run a **fuzzy backstop** (e.g., Dice/Levenshtein) to find
     the nearest candidate(s) above a confidence threshold.
   - **Unique confident match** → use it (resolve to the registry's absolute path
     for `--workspace`).
   - **No match / multiple plausible matches / below threshold** → return a
     structured `needs_disambiguation` error listing the candidates, so the model
     asks the user instead of guessing.
   - **Disabled project** → reject.
4. **Never trust a path.** The caller supplies a *name*, never a path. The path
   comes from the registry only (see `03-security.md`).
5. **Readback for risky ops.** For `cursor_submit`/`cursor_revert`, the system
   prompt instructs the model to confirm the target on low confidence or for
   destructive intent ("Working in **budget** — go ahead?"). Avoid confirming on
   every call (don't nag; preserve flow).

### Validation rules (enforced server-side)

- `project` → resolve via registry name/alias/fuzzy; reject if unresolved,
  ambiguous, or disabled. Use the registry's stored absolute path as
  `--workspace`. If omitted, use the session's active project; if there is none,
  return `no_active_project` so the model asks which one.
- `prompt` → non-empty, length-capped; passed as a single argv element.
- `question` (`cursor_ask`) → non-empty, length-capped; run **only** in
  `--mode ask` (read-only); never resolves to a writing run.
- `mode` → enum; default per config (recommend `agent`, with optional
  `plan`-first config toggle).
- `job_id` / `session_id` → must exist in state DB and belong to the project.

## cursor-agent CLI — confirmed reference (June 2026)

> Beta: "flags may change between releases." Pin the version; add a startup
> self-check (`cursor-agent --help` / `--list-models`) and log the detected
> version.

| Flag | Use here |
| --- | --- |
| `-p, --print` | Always (non-interactive). |
| `--output-format text\|json\|stream-json` | Use **`stream-json`** for progress + final result. |
| `--stream-partial-output` | Optional; char-level deltas (probably unnecessary for voice). |
| `--resume [chatId]` | Resume per-project session. |
| `--continue` | Alias for `--resume=-1` (most recent). |
| `--model <model>` | Pin the executor model (separate from the voice provider). |
| `--mode plan\|ask` | `agent` is default; `plan` for plan-first flow. |
| `--force` / `--yolo` | Auto-run + apply changes. *"Force allow commands unless explicitly denied"* — **the `deny` list still applies.** Without it, headless silently denies non-allowlisted commands (no prompt either way). |
| `--trust` | Required for headless; skips workspace-trust prompt. Scope to the allowlisted workspace. |
| `--sandbox enabled\|disabled` | Optional defense-in-depth (OS-level boundaries; non-sandboxable commands fail instead of prompting). |
| `--workspace <dir>` | **Always** — from registry, never from caller. |
| `--approve-mcps` | Only if the executor agent itself uses MCPs. |
| `agent ls` | Lists **chat sessions for a workspace**, not projects. Scoped to `--workspace` (defaults to cwd). Use `cursor-agent ls --workspace <registry path>` when recovering a specific project's sessions. |

### Pre-run flags (configurable, default = force)

Every invocation gets a **configurable pre-run flag set** applied uniformly,
sourced from `config.json` settings (`preRunFlags`, see `07`). Default:

```jsonc
// config.json → settings
"preRunFlags": ["--force", "--trust"]   // auto-run + apply + skip trust prompt
```

- This is the one place to change run behavior for *all* requests (e.g., add
  `--sandbox`, `--approve-mcps`, or drop `--force` for a propose-only mode).
- `--force` honors the **`deny` list** in the CLI permission files (see `03`/`07`),
  so "default force" still has hard guardrails.

### Canonical invocation (built in code, `shell:false`)

```ts
const args = [
  "-p",
  "--output-format", "stream-json",
  "--workspace", project.path,        // from registry
  "--model", config.executorModel,
  ...config.preRunFlags,              // default: --force --trust
  ...(resumeId ? ["--resume", resumeId] : []),
  ...(mode === "plan" ? ["--mode", "plan"] : []),
  prompt,                             // single argv element
];
spawn("cursor-agent", args, { cwd: project.path, shell: false, env: scopedEnv });
```

### `cursor_ask` invocation (read-only context for the voice model)

```ts
const args = [
  "-p",
  "--output-format", "json",          // single answer; no progress needed
  "--workspace", project.path,
  "--model", config.executorModel,
  "--mode", "ask",                    // READ-ONLY: cannot edit or run mutating cmds
  ...config.preRunFlags,              // harmless in ask mode (read-only)
  question,
];
// one-shot by default (no --resume) so exploration never pollutes the work thread
```

`cursor_ask` is the **only** repo-context path for the voice model. It runs in
`--mode ask` (read-only exploration — searches/reads, makes no changes), returns
the answer text, and does **not** persist to the project's work session.

`--workspace` is **always** present and always comes from the registry
(`project.path`), never from caller input. It is the single value that scopes
both *where edits happen* and *which session history is visible* (sessions are
workspace-scoped — see `07`).

## Session bootstrap & resume flow

This is the lifecycle of a project's `cursor-agent` session, from first run to
every subsequent resume. The bridge owns this; the model only calls tools.

```
cursor_submit(project) → resolve project → path (registry)
        │
        ├─ resume_id known for this project?
        │
        ├─ NO  → FIRST RUN (bootstrap a session)
        │        spawn: cursor-agent -p --output-format stream-json
        │               --workspace <path> --force --trust "<prompt>"
        │        parse stream → capture session_id from the events
        │               (the "grep id" step: read it off the JSON, not the screen)
        │        persist project.resume_id = session_id
        │
        └─ YES → RESUME
                 spawn: cursor-agent -p --output-format stream-json
                        --workspace <path> --resume <resume_id> --force --trust "<prompt>"
                 (must reuse the SAME --workspace the session was created under)
        │
        └─ on completion: refresh project.resume_id from the run's session_id
```

Key points:

1. **Capture the id from structured output, not by scraping a TTY.** With
   `--output-format stream-json`/`json` the `session_id` is a field on the
   events/result object. Read it programmatically; do not regex a terminal
   screen. (`strip-ansi` remains defensive-only.) The id is consistent within a
   run.
2. **Persist per project.** `resume_id` is stored on the `project` row (see `07`)
   so a project always continues its own thread across bridge restarts.
3. **`--resume` is always paired with `--workspace`.** Resuming under a different
   workspace silently starts fresh (CLI sessions are workspace-scoped). The
   bridge guarantees the pairing because both derive from the same registry entry.
4. **`cursor_new_session`** clears `resume_id` for a project, forcing the next
   `cursor_submit` back through the FIRST-RUN path.
5. **Initial prompt construction.** The bridge builds the prompt argv element
   from the model's task text only; workspace/flags are added in code. No host
   shell string is ever assembled (`shell:false`, args array).

## Auto-run, permissions & clarifying questions

A hard requirement for the voice flow: **`cursor-agent` must never stall waiting
for input.** Confirmed behavior (Cursor CLI docs, June 2026):

### Headless mode is non-blocking by design

- **No permission dialogs in print mode.** Without `--force`, any non-allowlisted
  command is **silently denied** and the agent adapts to the failure on its own;
  with `--force`, it runs. **Neither path pops an interactive prompt** — so a
  headless run cannot hang on "approve this command?".
- **Applying changes = `--force`.** Without `--force`, file changes are only
  *proposed, not applied*; with `--force` (alias `--yolo`) they are written
  directly. "Accepting changes" is therefore a flag, not an interactive step.
- **`--trust`** skips the workspace-trust prompt (headless only).
- **No interactive Q&A.** Print mode has no back-and-forth; the agent runs to
  completion and returns. `thinking` events are suppressed. The agent does **not**
  pause mid-run to ask the user a question.

### Recommended invocation: auto-run **with a deny list** (not blanket yolo)

`--force` means *"force allow commands unless explicitly denied"* — the **`deny`
list still applies under `--force`.** This gives us auto-run flow *and* hard
guardrails. Configure CLI permissions in `~/.cursor/cli-config.json` (global) or
`<workspace>/.cursor/cli.json` (project-level; only `permissions` is allowed
there):

```json
{
  "version": 1,
  "permissions": {
    "allow": [],
    "deny": [
      "Shell(rm)",
      "Shell(sudo)",
      "Shell(git:push*)",
      "Read(.env*)",
      "Write(**/*.key)",
      "Write(**/*.pem)"
    ]
  }
}
```

- Deny rules take precedence over allow; entries are exact-string/glob tokens
  (`Shell(...)`, `Read(...)`, `Write(...)`, `WebFetch(...)`, `Mcp(...)`).
- This blocks destructive/sensitive ops **even in auto-run**, satisfying the
  "enforce security at the boundary" rule without losing hands-free flow.
- Optional defense-in-depth: `--sandbox enabled` (OS-level filesystem/network
  boundaries; non-sandboxable commands simply fail and the agent reacts).
- `--approve-mcps` only if the executor agent itself calls MCP servers.

Provision these permission files as part of deployment (see `07`) so every
project the bridge runs gets the same guardrails. Treat the deny list as part of
the security configuration, version-controlled via `config.example`.

### Is there a flag to "skip cursor's questions"?

**No dedicated flag — and none is needed.** Headless mode has no interactive Q&A;
the agent never *pops* a question. Two practical implications:

- **It won't stall asking.** With `preRunFlags` defaulting to `--force --trust`,
  permission/trust decisions are pre-answered. There is no prompt to skip.
- **To keep the agent heads-down (don't emit questions, just proceed),** steer it
  via the **prompt text** the bridge builds, e.g. prepend a standing instruction:
  *"Make reasonable assumptions and proceed; do not ask clarifying questions."*
  This is prompt-level, not a CLI flag. The questions we *want* come from the
  **voice model**, not the agent.

### Clarifying questions: the voice model stays "dumb"

Design rule (confirmed): the **voice model has no repo access**. It only drafts
prompts and converses. To gain context it **delegates to `cursor-agent` in ask
mode** instead of guessing. Order of operations when the voice model is unsure:

```
Dad says something ambiguous
      │
      ├─ Is the ambiguity about the REPO/code? ── yes ──► cursor_ask(question)   [--mode ask, read-only]
      │        (e.g., "is there already a settings page?")        │
      │                                                           ▼
      │                                              use the answer to either:
      │                                                ├─ draft a precise cursor_submit, or
      │                                                └─ ask Dad a better, informed question
      │
      └─ Is the ambiguity about INTENT/preference? ── yes ──► ask Dad directly
               (e.g., "dark mode default on or off?")   (cursor can't know this)
```

So the voice model **asks `cursor` before it asks Dad** for anything the repo
could answer, and only bothers Dad with intent/preference decisions. This keeps
the voice model cheap/simple while answers stay grounded in the real codebase.

### After a run — clarification via session resume

If a `cursor_submit` run's **final output** still contains a question or flags
uncertainty, the bridge returns that text → the voice model **speaks it to Dad**
→ Dad answers → the voice model calls `cursor_submit` again, which **`--resume`s
the same session** with the answer. Multi-turn is **session-level**, not a
blocking in-run prompt. (`--mode plan` remains available for plan-first
confirmation on risky/vague tasks.)

Net separation of concerns:

- **Voice model** = conversational layer (drafts prompts, asks Dad, asks
  `cursor_ask` for repo facts). No repo access, stays dumb.
- **cursor-agent (ask)** = read-only knowledge source for the voice model.
- **cursor-agent (agent)** = run-to-completion executor that applies changes.

## ⚠️ The node-pty question (validate first, then likely drop)

The original plan assumed `node-pty` is required for a TTY. **Cursor's docs say
print mode is inferred for non-TTY/piped stdin**, and `--print` exists precisely
for scripts/CI. Plan:

1. **Spike (Milestone 0):** run the canonical invocation via plain
   `child_process.spawn` (no pty) and confirm clean `stream-json` output and a
   final JSON object.
2. If clean → **drop `node-pty`** (one less native dep, less ANSI noise).
3. If the CLI misbehaves without a TTY → fall back to `node-pty`, but keep parsing
   identical. Either way, parsing logic is transport-agnostic.

Document the spike outcome in `08-decisions-and-risks.md`.

## Output parsing

- **`stream-json`**: newline-delimited JSON events. Each line = one event,
  terminated `\n`. `thinking` events are suppressed in print mode. Consume:
  - tool-call start/finish events → emit progress for "still working…" narration
    (correlate via tool-call IDs).
  - the terminal result event → the spoken summary + session id.
- **`json`** (alternative): a single JSON object emitted at completion (no
  deltas). Simpler, but no progress — worse for voice.
- **Robustness:** ignore unknown fields (forward-compatible, per docs); still run
  `strip-ansi` defensively before parse; tolerate partial trailing lines by
  buffering until `\n`.
- **Session id:** stays consistent within a run; capture it and persist as the
  project's resume id.

## Job lifecycle & concurrency

```
cursor_submit → create job row (status=running) → spawn agent
   │  stream events → append to job.progress + audit
   │  on final result → status=done, store summary/diffstat, persist resume id
   │  on nonzero exit / parse error → status=error, capture stderr tail
cursor_status(job_id) → read job row
cursor_stop(job_id) → SIGTERM→SIGKILL the pid, status=stopped
```

- **Concurrency cap** (config, e.g., 1–2 jobs) to protect the home machine.
- **Per-job timeout**; on timeout → stop + status=error with a spoken apology.
- **Reaping:** track pid; ensure no zombies on crash/restart; on bridge startup,
  mark orphaned `running` jobs as `error` (their process died with the old
  bridge).

## Git strategy (`cursor_revert` / `cursor_diff`) via `simple-git`

Decision needed at implementation time (tracked in `08`): how aggressive is
revert? Recommended safe default:

- Before each `cursor_submit`, record the current HEAD + whether the tree is
  clean (a checkpoint row).
- `cursor_diff` → `git diff --stat` (+ optional full patch) of working tree.
- `cursor_revert` → restore to the pre-job checkpoint:
  `git stash`/`git checkout -- .` for uncommitted changes, or
  `git reset --hard <checkpoint>` if the agent committed (configurable; destructive
  resets gated behind a confirmation in the voice flow).
- Never auto-`git push`. Pushing is out of scope for the voice flow.

## Provider function-call ↔ MCP mapping

Because tools are defined once (zod), generate:

- **MCP** registrations for the in-process MCP server.
- **Provider function tools** for the realtime `session.update` config.

The phone forwards a provider function call `{name, arguments}` to the bridge;
the bridge dispatches by `name` into the same handler the MCP server uses. One
handler set, two entry points (DRY + reusability).
