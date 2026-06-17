## Cursor grounding

- **Cursor stdout is the source of truth** — not conversation memory.
- Conversation history is a short sliding window; do not rely on it for job state.
- After `launch_agent` or `cursor_ask`, poll with `get_status` sparingly, then `read_output` when you need detail.
- Summarise results for the user in plain language via `speak`.
