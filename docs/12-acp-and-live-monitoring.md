# 12 — ACP, Live Monitoring & Cursor Question Handling

This document answers two questions raised during design:
1. Can the bridge **subscribe to / monitor** cursor-agent output and react to it live?
2. Should the agent have access to the **TUI interface** and interact with it?

---

## The short answers

| Question | Answer |
| --- | --- |
| Can we subscribe to live output? | **Yes, fully — via ACP (Agent Client Protocol)** |
| Should we use the TUI? | **No — ACP supersedes it and is the right integration path** |
| Can cursor ask *us* questions mid-run? | **Yes — ACP has a blocking `cursor/ask_question` method we must handle** |
| Can cursor send plan approvals? | **Yes — `cursor/create_plan` is a blocking extension that awaits our response** |
| Can we cancel mid-run? | **Yes — `session/cancel`** |
| Can we handle tool permissions programmatically? | **Yes — `session/request_permission` with `allow-once`, `allow-always`, `reject-once`** |

---

## ACP — Agent Client Protocol

`cursor-agent acp` starts the CLI as a **bidirectional JSON-RPC 2.0 server over
stdio**. The bridge spawns it as a child process and communicates line-by-line
(NDJSON). This is the **official integration path for custom clients** — it
is what JetBrains, Neovim (avante.nvim), Zed, and other editors use.

Verified live (June 2026, CLI `2026.06.04-5fd875e`):

```
bridge spawns: cursor-agent acp
               stdin ←→ stdout   (JSON-RPC NDJSON)
               stderr           (debug logs)
```

This replaces the `child_process.spawn -p --output-format stream-json` approach
for `cursor_submit`. ACP gives us everything `stream-json` gives us **plus**:

- **Bidirectional** — cursor can send *us* requests mid-run (questions, plan
  approvals, permission requests).
- **Session management** — `session/new`, `session/load` (resume), `session/list`.
- **Cancellation** — `session/cancel` while running.
- **Tool permission control** — `session/request_permission` per tool call.
- **Extension events** — todo updates, subagent task notifications, image generation.

---

## ACP request flow (confirmed from docs + live test)

```
bridge                               cursor-agent acp
  │
  ├─ initialize  ──────────────────────────────────────────────────►
  │              ◄──── { protocolVersion, agentCapabilities, authMethods } ──
  │
  ├─ authenticate { methodId:"cursor_login" }  ─────────────────────►
  │              ◄──── { authenticated: true } ─────────────────────
  │
  ├─ session/new { cwd, mode, mcpServers } ─────────────────────────►
  │              ◄──── { sessionId }  ──────────────────────────────
  │
  ├─ session/prompt { sessionId, prompt:[{type:"text",text:"..."}] }►
  │              ◄──── session/update notifications (streaming) ─────
  │              ◄──── session/request_permission (blocking, if needed)
  │              ◄──── cursor/ask_question (blocking, if agent asks)
  │              ◄──── cursor/create_plan (blocking, if plan mode)
  │              ◄──── cursor/update_todos (notification)
  │              ◄──── cursor/task (notification, subagent)
  │              ◄──── { stopReason } (session/prompt resolves)
```

**Live test confirmed:** `initialize` returns immediately with capabilities and
auth methods. `session/new` works and returns a session ID. The service user
auth (`cursor_login`) needs the service user to have run `cursor-agent login`
first (one-time setup, via SSH — not part of the voice flow).

---

## ACP vs `--print` (stream-json): architecture decision

| Feature | `--print --output-format stream-json` | `cursor-agent acp` |
| --- | --- | --- |
| Live streaming events | ✅ | ✅ |
| Session resume (`--resume`) | ✅ | ✅ (`session/load`) |
| Cursor asks *us* questions | ❌ silently skipped / output text | ✅ `cursor/ask_question` (blocking) |
| Plan approval | ❌ output text only | ✅ `cursor/create_plan` (blocking) |
| Tool permission per-call | ❌ `--force` / deny list only | ✅ `session/request_permission` |
| Cancel mid-run | ❌ SIGKILL only | ✅ `session/cancel` |
| Session list | ❌ requires TTY | ✅ `session/list` (via `sessionCapabilities`) |
| One process reuse | ❌ spawn per job | ✅ persistent process, multiple sessions |
| Complexity | Low | Medium |

**Recommendation: use ACP for `cursor_submit` and `cursor_ask`** in the full
implementation (Milestone 2+). Keep the `--print` approach for the Milestone 0
spike (simpler to validate) then migrate to ACP once the spike confirms the
`--workspace` / resume semantics.

> ADR recorded in `08`. The spike (Milestone 0) validates with `--print`; ACP is
> the production executor transport.

---

## Handling cursor's questions via ACP

This is the key capability that the `--print` path lacked. ACP has **two blocking
extension methods** the agent uses when it needs human input:

### `cursor/ask_question` (blocking — agent waits for our response)

Cursor asks a structured multiple-choice question and **blocks until we reply**.

```ts
// Incoming from cursor (bridge must respond):
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "cursor/ask_question",
  "params": {
    "toolCallId": "call_123",
    "title": "Which approach?",
    "questions": [{
      "id": "q1",
      "prompt": "Should I also update the tests?",
      "options": [
        { "id": "yes", "label": "Yes, update tests" },
        { "id": "no",  "label": "No, skip tests" }
      ],
      "allowMultiple": false
    }]
  }
}

// Bridge must respond:
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "outcome": {
      "outcome": "answered",
      "answers": [{ "questionId": "q1", "selectedOptionIds": ["yes"] }]
    }
  }
}
```

**Voice flow integration:**

```
cursor/ask_question arrives at bridge
        │
        ├─ bridge pauses the job (status: "waiting_input")
        ├─ bridge → voice model: speak the question to dad
        │       "Cursor wants to know: should I also update the tests?
        │        Say yes or no."
        │
        dad answers by voice
        │
        ├─ voice model maps answer → option id
        ├─ bridge → cursor: JSON-RPC response with selected option
        │
        cursor continues
```

This is a **first-class integration point**: the bridge is the answer relay
between cursor's structured question and dad's spoken answer. The voice model
formats the question as natural speech and maps the response back to an option ID.

### `cursor/create_plan` (blocking — agent waits for approval)

Cursor proposes a full plan (markdown + todo list) and blocks until we
accept or reject. This is how **plan mode** surfaces to the client.

```ts
// Response options:
{ "outcome": { "outcome": "accepted" } }
{ "outcome": { "outcome": "rejected", "reason": "too many changes" } }
{ "outcome": { "outcome": "cancelled" } }
```

**Voice flow integration:**

```
cursor/create_plan arrives
        │
        ├─ bridge → voice model: speak the plan overview
        │       "Cursor has a plan: it will 1) update the settings component,
        │        2) add a dark mode toggle, 3) update the tests.
        │        Should I go ahead?"
        │
        dad: "Yes" / "No" / "Stop"
        │
        ├─ voice model calls a new tool: cursor_approve_plan / cursor_reject_plan
        │   OR maps to an existing tool result
        ├─ bridge → cursor: accept / reject
```

---

## Notification-only events (no response needed)

| Event | What it carries | Voice use |
| --- | --- | --- |
| `cursor/update_todos` | Current todo list + statuses | Narrate progress ("done step 1 of 3") |
| `cursor/task` | Subagent task description + type | "Running a search subagent…" |
| `cursor/generate_image` | Image path + description | Out of scope for voice |
| `session/update` | Streaming text chunks + tool events | Progress narration, transcript |

---

## `session/request_permission` (per-tool approval)

When a tool call needs approval (and `--force` isn't set), cursor sends this:

```ts
// Response options:
{ "outcome": { "outcome": "selected", "optionId": "allow-once" } }
{ "outcome": { "outcome": "selected", "optionId": "allow-always" } }
{ "outcome": { "outcome": "selected", "optionId": "reject-once" } }
```

**For the voice flow:** The bridge can pre-respond `allow-once` automatically
(equivalent to `--force`) while still maintaining the deny list in permissions
config. Or it can surface to the voice model for dad to approve risky commands
("cursor wants to run `npm install` — allow?"). This gives **finer per-call
control** than the blanket `--force` flag.

This is the **preferred production path** over `--force` because it allows
selective approval by voice rather than blanket auto-approve.

---

## Why not the TUI?

The TUI (`cursor-agent` in interactive mode) is an Ink-based React terminal app.
To interact with it programmatically would require:

1. `node-pty` to provide a fake TTY.
2. Sending raw keystrokes to simulate user input.
3. Scraping terminal screen state (ANSI escape sequences).
4. No structured event model — brittle, breaks on any UI update.

**ACP makes the TUI irrelevant for our use case.** ACP is the *official*
programmatic integration path that the TUI itself is built on top of. It gives
us structured JSON-RPC events, blocking question/approval handling, cancellation,
and session management — everything the TUI provides, without the fragility.

**Verdict: use ACP, skip the TUI entirely.**

---

## Updated MCP tool additions (from ACP capabilities)

ACP unlocks two tools that were not possible with `--print`:

| New/updated tool | What changes |
| --- | --- |
| `cursor_approve_plan` | New. Responds to a pending `cursor/create_plan` request (accept / reject / cancel). Bridge holds the pending RPC id until this is called. |
| `cursor_answer_question` | New. Responds to a pending `cursor/ask_question`. Voice model calls this after getting dad's spoken answer. |
| `cursor_status` | Enhanced. Can now include `waiting_input` status and the pending question/plan payload so the voice model knows what to ask. |
| `cursor_stop` | Enhanced. Now sends `session/cancel` (clean) instead of SIGKILL where possible. |

These bring the tool count to **18**.

---

## Implementation notes

- **One persistent `cursor-agent acp` process per bridge instance** (or per
  project if isolation is needed). Sessions are multiplexed on top.
- **Startup:** `initialize` → `authenticate` at bridge start; reuse the
  connection for all subsequent `session/new` / `session/load` calls.
- **Auth:** the service user must have run `cursor-agent login` once (SSH setup).
  `authenticate { methodId: "cursor_login" }` then uses the stored credentials.
- **Reconnect:** if the ACP process crashes, restart it and re-initialize; resume
  sessions by `session/load` with the stored session IDs.
- **`--print` compatibility:** keep the `--print` path as a **fallback** (e.g.,
  if ACP is unavailable or for the Milestone 0 spike). The output parsing code is
  not wasted — it handles `stream-json` from `--print` which has the same event
  shape as `session/update` chunks.

---

## Revised source module layout

```
src/executor/
├── acp.ts           # ACP child process: spawn, initialize, authenticate, reconnect
├── session.ts       # session/new, session/load, session/cancel; pending Q&A state
├── events.ts        # session/update handler: streaming, todos, tasks, permissions
├── questions.ts     # pending cursor/ask_question + cursor/create_plan state machine
├── cursorAgent.ts   # --print fallback path (spike + compatibility)
└── git.ts           # simple-git: diff, revert, checkpoint
```

The `questions.ts` module holds **pending blocking RPCs** (question/plan)
indexed by `toolCallId`, so the voice model can call `cursor_answer_question` /
`cursor_approve_plan` as separate MCP tool calls after getting dad's input.
