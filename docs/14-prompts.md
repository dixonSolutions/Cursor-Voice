# Voice & agent prompts (`prompts/`)

Agent instructions are **editable markdown files**, not long strings in `config.json`.

## Layout

```
prompts/
├── cursor-voice/
│   ├── system.md              # Voice agent system prompt (cursor_native)
│   └── mcp-instructions.md    # MCP server instructions for Cursor
├── llm-intelligence/
│   ├── systemprompts.json     # Orchestrator manifest
│   ├── activation-rules.md
│   └── orchestrator/          # Modular Claude sections
├── messenger/                 # Legacy modular sections (reference)
└── systemprompts.json         # Legacy S2S manifest (unused)
```

## cursor_native — voice agent

| File | Loaded by | When |
| --- | --- | --- |
| `prompts/cursor-voice/system.md` | `cursorVoiceRuleBody()` | First `cursor-agent` spawn only |
| `prompts/cursor-voice/mcp-instructions.md` | `cursorVoiceMcpInstructions()` | MCP `/mcp` server instructions |
| `.cursor/rules/cursor-voice.mdc` | Cursor rule injection | Resume spawns via `@cursor-voice` |

Boot prompt lifecycle: see [`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md) §6.

Loader: `src/mcp/loadCursorVoicePrompt.ts`.

## llm_intelligence — orchestrator

```json
{
  "settings": {
    "workflow": {
      "llmIntelligence": {
        "systemPrompts": ["prompts/llm-intelligence/systemprompts.json"]
      }
    }
  }
}
```

Paths are relative to `config.json`. Loaded at startup by `src/state/promptLoader.ts`.

## Placeholders (llm_intelligence)

| Placeholder | Source |
| --- | --- |
| `{{ACTIVATION_RULES}}` | `activation-rules.md` |
| `{{PROJECT_CATALOG}}` | Registered projects |
| `{{WAKE_START}}` | `settings.voice.wakeWords.start` |

## Workflow → prompt mapping

| Workflow | Prompt source |
| --- | --- |
| `cursor_native` | `prompts/cursor-voice/system.md` + `@cursor-voice` rule on resume |
| `llm_intelligence` | `prompts/llm-intelligence/systemprompts.json` |

## Related docs

- [`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md) — voice agent boot prompting
- [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) — orchestrator config
- `src/state/promptLoader.ts` — manifest loader
