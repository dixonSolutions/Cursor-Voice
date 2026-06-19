# 06 — Voice, Audio, STT & TTS

> Filename kept for link stability. WebRTC / speech-to-speech was removed; this doc
> covers the current cascade audio path.

## Overview

Both workflows (`cursor_native` and `llm_intelligence`) share the same PWA audio
pipeline. The phone handles capture and playback; the bridge handles turn routing
and (for `llm_intelligence`) Claude orchestration.

```
Mic → Vosk (wake/end) → STT (WebKit or Transcribe) → /ws/intelligence
                                                              │
Assistant audio ← WebKit TTS or Polly ← speak events ←────────┘
```

## Session class

`web/src/llm-intelligence-session.ts` — used for **both** workflows. Connects to
`/ws/intelligence`, manages wake word gating, VAD, STT buffering, and TTS playback.

Callback types: `web/src/voice-session-types.ts`.

## Wake words (Vosk)

- **Start phrase** (`settings.voice.wakeWords.start`) — activates utterance capture.
- **End phrase** (`settings.voice.wakeWords.end`) — optional submit when VAD is off.
- Offline WASM grammar spotter — requires COOP/COEP headers (see `webDispatch.ts`).
- Configure in Config tab or `PATCH /api/voice/wake-words`.

## Turn submit

| Mode | Config | Behavior |
| --- | --- | --- |
| **Silero VAD** (default) | `turnSubmit.vadEnabled: true` | Detect speech end → submit |
| **End phrase** | `vadEnabled: false` | Vosk listens for end phrase |
| **Silence fallback** | `turnSubmit.silenceMs` | Auto-submit after N ms quiet |

## STT backends

| Backend | When used |
| --- | --- |
| **WebKit SpeechRecognition** | iPhone Safari / PWA (preferred) |
| **Amazon Transcribe** | Desktop fallback when WebKit unavailable |
| **Typed input** | Voice tab text field (dev / no mic) |

Transcribe: `POST /api/intelligence/transcribe` (bridge proxies with IAM keys).

## TTS backends

| Backend | When used |
| --- | --- |
| **WebKit speechSynthesis** | iPhone (preferred) |
| **Amazon Polly** | Desktop fallback; also `llm_intelligence` transcript fallback |

Polly: `POST /api/intelligence/tts` (bridge proxies with IAM keys).

For **`cursor_native`**, primary TTS comes from MCP `speak()` events pushed over
`/ws/intelligence`. For **`llm_intelligence`**, orchestrator `speak` tool + optional
browser TTS fallback (`web/src/tts-fallback.ts`).

## TTS barge-in

User can say the wake phrase during assistant playback. The client:

1. Stops TTS and snapshots what was playing (`heard_complete`, `heard_partial`, `not_spoken`)
2. Opens mic capture for the new request
3. Sends `tts_interrupt` with the next `user_turn` so Cursor knows what was heard

Cursor receives the snapshot via `next_voice_turn()` → `tts_interrupt`.

**Wake-word echo:** If assistant TTS says the wake phrase aloud, Vosk may hear it
from the speaker. The client ignores that detection when the **current TTS line**
contains the wake phrase — barge-in stays enabled for real user interrupts.

Full flow, data shapes, and file map: [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md).

Types: `src/voice/ttsInterrupt.ts`, `web/src/tts-interrupt.ts`.

## WebSocket endpoints

| Path | Purpose |
| --- | --- |
| `/ws/intelligence` | Voice turns, speak events, tool activity, agent status |
| `/ws/control` | Legacy tool relay + narrator (worker jobs) |

## Audio processing

`web/src/audio.ts` — mic capture, echo cancellation, noise gate.
`web/src/silero-vad.ts` — speech-end detection.
`web/src/voice-audio-meter.ts` — orb visualization levels.

## Related docs

- [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md) — barge-in snapshot + wake echo filter
- [`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md) — Cursor voice loop
- [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) — Bedrock orchestrator
- [`13-voice-providers.md`](./13-voice-providers.md) — wake word config
