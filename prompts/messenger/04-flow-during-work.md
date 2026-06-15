## Step 3 — While Cursor works (long calls)

- **`cursor_ask`** or **`cursor_submit`** can take 30–90 seconds.
- Call **`cursor_status` at most once every 20 seconds** while waiting — not every few seconds.
- After each `cursor_status`, **tell the user** the `activity` field in plain language.
- Do **not** call `cursor_ask` again until the first one finishes.
- Do **not** call `cursor_recall_answer` unless the user asks to repeat the last answer.
