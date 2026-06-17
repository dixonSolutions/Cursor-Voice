# 15 — LLM Intelligence workflow

The **intelligence-first** workflow (`llm_intelligence`) replaces speech-to-speech (S2S)
models with a **cascade**: STT → LLM → TTS. Each layer is independently controllable,
debuggable, and upgradeable. S2S models (Nova Sonic, GPT Realtime) trade reasoning for
audio naturalness — the wrong tradeoff for an agentic coding assistant.

The legacy **S2S voice** workflow (`s2s_voice`) remains available for OpenAI WebRTC and
Bedrock Nova Sonic.

## Architecture

```
iPhone PWA (WebKit SpeechRecognition + SpeechSynthesis — free, on-device)
  → WebSocket /ws/intelligence
  → Claude Sonnet via Bedrock (orchestrator, prompt caching)
  → MCP tools (cursor_* + speak / get_status / launch_agent / read_output)
  → cursor-agent CLI (actual coding)
  → stdout fed back to Claude as grounded context
  → Claude calls speak(text) → bridge pipes to WebKit TTS → user hears it
```

### Why cascade beats S2S for agents

| | S2S (Nova, GPT Realtime) | Cascade (llm_intelligence) |
| --- | --- | --- |
| Reasoning | Weak instruction following | Claude Sonnet — strong tool use |
| Debug | Opaque audio loop | Each layer logged independently |
| Cost | Per-minute voice API | WebKit STT/TTS = $0 on phone |
| Upgrade | Monolithic model swap | Swap STT, LLM, or TTS independently |
| Grounding | Model may hallucinate repo state | Cursor stdout via `read_output` |

## Configuration (`config.json`)

```json
{
  "settings": {
    "workflow": {
      "default": "llm_intelligence",
      "llmIntelligence": {
        "llm": {
          "provider": "bedrock",
          "model": "us.anthropic.claude-sonnet-4-20250514-v1:0",
          "region": "us-east-1",
          "maxTokens": 4096
        },
        "systemPrompts": ["prompts/llm-intelligence/systemprompts.json"],
        "memory": {
          "maxTurns": 10,
          "keepTurns": 4,
          "summarySentences": 3
        },
        "readOutputMaxChars": 8000
      },
      "s2sVoice": {
        "systemPrompts": ["prompts/systemprompts.json"]
      }
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `workflow.default` | `llm_intelligence` (default) or `s2s_voice` |
| `llmIntelligence.llm.model` | Bedrock Converse model or inference profile ID (Claude 4 needs `us.anthropic.…` prefix) |
| `llmIntelligence.llm.region` | AWS region for Bedrock Converse API |
| `llmIntelligence.systemPrompts` | Manifest under `prompts/llm-intelligence/` |
| `llmIntelligence.memory.*` | Sliding window + summarisation thresholds |
| `llmIntelligence.readOutputMaxChars` | Trim tool payloads before returning to Claude |

**Credentials:** `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` in `.env` (IAM keys, not
Bedrock API keys). Same requirement as Nova Sonic voice.

To use S2S instead, set `"default": "s2s_voice"` and configure `settings.voice` providers.

## Turn flow

Each turn:

1. User speaks → WebKit STT → final transcript
2. Phone sends `{ type: "user_turn", text }` on `/ws/intelligence`
3. Bridge sends to Claude:
   - Cached system prompt (`prompts/llm-intelligence/`)
   - Summarised older history (if window exceeded)
   - Last N turns sliding window
   - Current transcript
4. Claude runs its native agentic loop:
   - Thinks invisibly
   - Calls `speak()` whenever it wants to communicate
   - Calls MCP tools whenever it needs Cursor
   - Interleaves freely
5. Bridge handles each tool call:
   - `speak(text)` → `{ type: "speak", text }` to phone immediately
   - `get_status()` → `cursor_status`, trimmed result
   - `launch_agent(task)` → `cursor_submit` (Claude should speak first)
   - `read_output()` → `cursor_status` with trimmed stdout
   - Other `cursor_*` tools → existing MCP dispatch
6. Loop continues until Claude stops
7. Bridge appends assistant turn to memory → `{ type: "turn_complete" }` → phone resumes STT

## Memory

- Conversation turns stored in-memory per WebSocket session (not SQLite).
- When `turns.length > memory.maxTurns`, Claude summarises older turns in
  `memory.summarySentences` sentences, keeps last `memory.keepTurns` turns.
- **Cursor state is never stored** — always queried fresh via `get_status` / `read_output`.

## System prompts

```
prompts/llm-intelligence/
├── systemprompts.json
├── activation-rules.md
└── orchestrator/
    ├── 01-identity.md
    ├── 02-agentic-loop.md
    ├── 03-tools.md
    ├── 04-cursor-grounding.md
    ├── 05-do-not.md
    └── 06-project-catalog.md
```

See [`14-prompts.md`](./14-prompts.md) for manifest format and placeholders.

## WebSocket protocol (`/ws/intelligence`)

**Phone → Bridge**

| Type | Payload |
| --- | --- |
| `auth` | `{ token }` — first frame |
| `user_turn` | `{ text }` — final STT transcript |
| `speaking` | `{ value: bool }` — WebKit TTS state (narrator cadence) |

**Bridge → Phone**

| Type | Payload |
| --- | --- |
| `auth_ok` | `{ sessionKey, workflow, wakeWords, turnSubmit, model }` |
| `speak` | `{ text }` — pipe to WebKit TTS immediately |
| `thinking` | `{ value: bool }` — orchestrator busy |
| `turn_complete` | turn finished, resume listening |
| `tool_activity` | `{ tool, phase, label, detail? }` |
| `narration` | narrator injection (same as `/ws/control`) |
| `error` | `{ message }` |

## Source modules

| Module | Role |
| --- | --- |
| `src/intelligence/orchestrator.ts` | Bedrock Converse agentic loop |
| `src/intelligence/ws.ts` | `/ws/intelligence` handler |
| `src/intelligence/tools.ts` | Tool definitions (speak + aliases + cursor_*) |
| `src/intelligence/executeTool.ts` | Bridge tool constraints |
| `src/intelligence/memory.ts` | Sliding window + compaction trigger |
| `src/intelligence/summarize.ts` | History summarisation via Claude |
| `web/src/webkit-stt.ts` | WebKit SpeechRecognition |
| `web/src/vosk-wake-word.ts` | Vosk grammar spotter (start + end phrases) |
| `web/src/turn-submit-buffer.ts` | Silence-timer turn buffer |
| `web/src/llm-intelligence-session.ts` | Phone session class |

## iPhone notes

- **STT:** `webkitSpeechRecognition` uses Apple's on-device engine (same family as Siri).
  Requires Safari / installed PWA with mic permission over HTTPS (Tailscale serve).
- **TTS:** `speechSynthesis` with local playback — zero network latency for speech output.
- Continuous recognition restarts automatically after each utterance.

## Desktop / non-iPhone fallbacks

When WebKit STT or TTS is unavailable, the PWA falls back to **Amazon Transcribe**
and **Amazon Polly** using the same IAM keys as Bedrock (configured in `.env`).

| Layer | Primary (iPhone) | Fallback (desktop) |
| --- | --- | --- |
| STT | WebKit SpeechRecognition | Amazon Transcribe (`POST /api/intelligence/transcribe`) |
| TTS | WebKit speechSynthesis | Amazon Polly (`POST /api/intelligence/tts`) |

### Wake word, submit phrase, and turn boundaries

Voice turns use **two configurable submit paths** (whichever fires first):

| Mechanism | Config | Detection |
| --- | --- | --- |
| **Silence submit** | `settings.voice.turnSubmit.silenceMs` | Timer reset on each STT final; auto-send after N ms of silence |
| **Submit phrase** | `settings.voice.wakeWords.end` | Local **Vosk** grammar spotter (same offline model as wake) |

**Inactive until start phrase** — random speech is discarded until
`settings.voice.wakeWords.start` matches (Vosk grammar mode, offline WASM).

**After activation** — STT finals are **buffered** (WebKit or Amazon). The buffer
flushes to Claude on silence timeout **or** when the submit phrase is heard.

**Combined utterances** — `"cursor listen add a button"` activates and buffers
`"add a button"`. Say `"cursor send"` or pause for `silenceMs` to submit.

Configure in `config.json` → `settings.voice`:

```json
"wakeWords": {
  "start": "cursor listen",
  "end": "cursor send"
},
"turnSubmit": {
  "silenceMs": 1500
}
```

- **`silenceMs`** — 500–30000 ms. Set high (e.g. 10000) if you prefer submit-phrase only.
- **`end`** — short phrase unlikely to appear in code commands. Detected by Vosk, not STT.
- Requires **COOP/COEP** headers for Vosk (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`). See wake-word test tab.

### Noise and pause during output

- **Noise filtering** — browser DSP (`echoCancellation`, `noiseSuppression`, `AGC`)
  plus high-pass (~180 Hz) and adaptive noise gate on the Amazon mic path; stricter
  VAD thresholds before activation (longer/louder speech required).
- **Pause during output** — STT and Vosk end-spotter pause while Polly/WebKit TTS
  plays or Claude is thinking (prevents echo and duplicate turns).

Configure in `config.json` → `settings.workflow.llmIntelligence.audio`:

```json
"audio": {
  "preferWebkit": true,
  "pollyVoiceId": "Joanna",
  "pollyEngine": "neural",
  "transcribeLanguageCode": "en-US"
}
```

**Testing without a mic:** after tapping the orb, use the **Type to test** field on the
Voice tab — messages go through the same Claude orchestrator loop.

The Voice tab shows active backends (e.g. `Amazon Transcribe · Amazon Polly`).

## Related docs

- [`02-architecture.md`](./02-architecture.md) — overall system (S2S path)
- [`11-mcp-tool-surface.md`](./11-mcp-tool-surface.md) — full cursor_* tools
- [`13-voice-providers.md`](./13-voice-providers.md) — S2S provider config
- [`14-prompts.md`](./14-prompts.md) — prompt editing workflow
