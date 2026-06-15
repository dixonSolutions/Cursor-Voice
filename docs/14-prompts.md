# Voice system prompts (`prompts/`)

The voice model's instructions are **editable markdown files**, not long escaped
strings inside `config.json`. Prompts are split into small, meaningful modules.

## Layout

```
prompts/
├── systemprompts.json       # manifest — activation + ordered messenger sections
├── activation-rules.md      # wake-word / active-inactive behavior
└── messenger/
    ├── 01-identity.md
    ├── 02-flow-identify.md
    ├── 03-flow-announce-tools.md
    ├── 04-flow-during-work.md
    ├── 05-user-questions.md   # answer user anytime, even while Cursor works
    ├── 06-flow-results.md
    ├── 07-tools-reference.md
    ├── 08-do-not.md
    ├── 09-project-catalog.md
    └── 10-language.md
```

`config.json` points at the manifest:

```json
{
  "settings": {
    "voice": {
      "systemPrompts": ["prompts/systemprompts.json"]
    }
  }
}
```

Paths in `systemPrompts` are **relative to `config.json`**.

## Manifest format (`systemprompts.json`)

```json
{
  "activationRules": "activation-rules.md",
  "messenger": [
    "messenger/01-identity.md",
    "messenger/02-flow-identify.md"
  ]
}
```

- **`activationRules`** — filename relative to the manifest directory.
- **`messenger`** — ordered list of section files, joined at load time.
- **`template`** (legacy) — single file instead of `messenger` array.

At startup the bridge reads the manifest, loads each `.md` file, and assembles
the final prompt in `src/realtime/session.ts`.

## Placeholders

Substituted at token mint — do not remove unless intentional:

| Placeholder | Source |
| --- | --- |
| `{{ACTIVATION_RULES}}` | `activation-rules.md` (after wake-word substitution) |
| `{{ACTIVE_PROJECT}}` | Project selected in the app (`settings` session `default`) |
| `{{PROJECT_CATALOG}}` | Other registered projects (reference only) |
| `{{WAKE_START}}` | `settings.voice.wakeWords.start` |

There is no spoken stop phrase — the user hangs up by tapping the orb only.

## Voice behavior (default)

The user **cannot see the screen**. The modular flow covers:

1. **Identify task** — speak first, then tools
2. **Announce tools** — say what you are about to do
3. **During work** — `cursor_status` sparingly
4. **User questions anytime** — never ignore the user while Cursor is busy
5. **Results** — mandatory spoken summary

Server-side helpers (not in prompts):

| Module | Role |
| --- | --- |
| `src/mcp/toolVoice/` | UI labels + injected TTS before/after tools |
| `src/realtime/bedrock/userInterruption.ts` | Nudge Nova when user speaks during cursor-agent |

Restart the bridge and start a **new voice session** after prompt changes.

## Related docs

- [`13-voice-providers.md`](./13-voice-providers.md) — provider config and token mint
- `src/state/promptLoader.ts` — manifest loader
- `src/realtime/session.ts` — placeholder assembly
