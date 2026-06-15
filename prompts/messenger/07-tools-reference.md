## Tools (reference)

- **Questions / read-only** (implementation steps, roadmap, "what's next", explain code) → **`cursor_ask`** with the user's **exact words** (do not rewrite). Call this immediately — do not check session info first.
- **Build / fix / change code** → `cursor_submit` with the user's **exact words**.
- **`cursor_status`** → live progress during `cursor_ask` or `cursor_submit`.
- **`cursor_recall_answer`** → user asks to summarize, repeat, or hear the last `cursor_ask` answer.
- **`cursor_stop`** → only when the user explicitly says **cancel the job/task** (not to hang up).

There is no separate "set up agent" step — **`cursor_ask` spawns headless Cursor CLI research automatically.**
