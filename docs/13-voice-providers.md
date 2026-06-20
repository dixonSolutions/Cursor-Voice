# 13 — Voice Settings & AWS Audio

How Cursor Voice configures wake words, turn submit timing, and AWS services for
STT/TTS fallback and the `llm_intelligence` orchestrator.

## config.json — voice settings

```json
{
  "settings": {
    "voice": {
      "wakeWords": {
        "start": "cursor listen",
        "end": "cursor send",
        "cancel": "cancel"
      },
      "turnSubmit": {
        "silenceMs": 1500,
        "vadEnabled": true
      },
      "tts": {
        "cursorVoiceEnabled": true,
        "interruptMode": "deafen",
        "interruptDeafenFactor": 0.2,
        "webkit": {
          "rate": 1.02,
          "pitch": 1,
          "volume": 1,
          "lang": "en-US"
        }
      }
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `wakeWords.start` | Activation phrase (Vosk offline detection) |
| `wakeWords.end` | Submit phrase when VAD is disabled |
| `wakeWords.cancel` | Abort phrase during capture (no turn sent) |
| `turnSubmit.silenceMs` | Silence before auto-submit (500–30000 ms) |
| `turnSubmit.vadEnabled` | Use Silero VAD for speech-end detection |
| `tts.cursorVoiceEnabled` | Play MCP `speak()` lines aloud |
| `tts.interruptMode` | `deafen` (duck volume) or `stop` (cancel speech) on barge-in |
| `tts.interruptDeafenFactor` | Volume multiplier during deafen capture (0–1) |
| `tts.webkit.*` | Default browser TTS rate/pitch/volume/lang |

Managed via Config tab or API:

- `GET /api/voice/providers` — returns `{ wakeWords, turnSubmit, tts, userName? }`
- `PATCH /api/voice/wake-words` — update wake words and turn submit
- `PATCH /api/voice/tts` — update cursor voice, interrupt deafen, WebKit defaults
- `PATCH /api/voice/user-name` — optional name the agent uses for the user

Per-browser TTS voice selection is stored in PWA localStorage (not `config.json`).
See [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md#browser-tts-options).

Implementation: `src/voice/voiceSettingsRegistry.ts`.

## AWS IAM keys (`.env`)

Used for **Amazon Polly** (TTS), **Amazon Transcribe** (STT), and **Bedrock Converse**
(Claude for `llm_intelligence`). **Not** used for speech-to-speech models (removed).

| Env var | Required | Purpose |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | Yes (for AWS features) | IAM access key (AKIA…) |
| `AWS_SECRET_ACCESS_KEY` | Yes | IAM secret |
| `AWS_REGION` | Optional | Defaults to `us-east-1` / llm region |
| `AWS_BEARER_TOKEN_BEDROCK` | Optional | Text-only Bedrock API key — **not** valid for Polly/Transcribe |

Validation: `src/intelligence/aws/credentials.ts` — rejects Bedrock API key IDs for
audio services.

## Audio API routes

| Route | Service |
| --- | --- |
| `POST /api/intelligence/tts` | Amazon Polly → MP3 |
| `POST /api/intelligence/transcribe` | Amazon Transcribe streaming |

Client modules: `web/src/amazon-tts.ts`, `web/src/amazon-stt.ts`.

## Workflow selection

Set in `config.json`:

```json
"workflow": {
  "default": "cursor_native",
  "llmIntelligence": { ... }
}
```

| Workflow | AWS usage |
| --- | --- |
| `cursor_native` | Polly/Transcribe fallback only (WebKit preferred) |
| `llm_intelligence` | Bedrock Converse + Polly/Transcribe fallback |

## Security

- `.env` is chmod 600, never committed, never returned by API.
- Wake word updates require app token (`/api/voice/wake-words`).
- Polly/Transcribe routes require app token.

## Related docs

- [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) — STT/TTS pipeline
- [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) — Bedrock orchestrator config
