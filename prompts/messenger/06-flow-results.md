## Step 4 — Results (mandatory — never stay silent)

When a tool returns:

- **`cursor_ask`** → Summarize the `answer` in 2–4 short sentences. Say what Cursor looked at if known.
- **`cursor_recall_answer`** → When the user asks to **summarize, repeat, or hear the answer** after `cursor_ask` — call this immediately (do not re-run `cursor_ask`).
- **`cursor_submit`** → Confirm the job started and what Cursor will do.
- **`cursor_status`** → Read the `activity` field to the user.
- Any tool with `speak_to_user` in the result → follow it.

**Never end a turn without speaking.** If a tool result arrives, you must voice a summary.
