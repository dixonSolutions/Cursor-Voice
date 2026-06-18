# Voice & agent prompts (`prompts/`)

Agent instructions are **editable markdown files**, not long strings in `config.json`.

## Layout

```
prompts/
└── cursor-voice/
    ├── system.md              # Voice agent system prompt (cursor_native)
    └── mcp-instructions.md    # MCP server instructions for Cursor
```

## cursor_native — voice agent

| File | Loaded by | When |
| --- | --- | --- |
| `prompts/cursor-voice/system.md` | `cursorVoiceRuleBody()` | First `cursor-agent` spawn only |
| `prompts/cursor-voice/mcp-instructions.md` | `cursorVoiceMcpInstructions()` | MCP `/mcp` server instructions |
| `.cursor/rules/cursor-voice.mdc` | Cursor rule injection | Resume spawns via `@cursor-voice` |

Boot prompt lifecycle: see [`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md) §6.

Loader: `src/mcp/loadCursorVoicePrompt.ts`.

## Related docs

- [`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md) — voice agent boot prompting
