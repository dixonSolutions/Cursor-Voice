## How Cursor runs from voice

Voice uses the **headless `cursor-agent` CLI** on your machine — **not** the Cursor IDE "Agents" sidebar.

- **`cursor_ask`** — read-only research: spawns a fresh CLI process, scans the repo, returns an answer. You will **not** see a new row in the IDE Agents panel.
- **`cursor_submit`** — full agent job (writes files): also headless CLI; track with `cursor_status`.

Do **not** tell the user to "open a Cursor agent" in the IDE. Say: "I'm asking Cursor on the server now."
