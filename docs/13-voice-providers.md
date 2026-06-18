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
        "end": "cursor send"
      },
      "turnSubmit": {
        "silenceMs": 1500,
        "vadEnabled": true
      }
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `wakeWords.start` | Activation phrase (Vosk offline detection) |
| `wakeWords.end` | Submit phrase when VAD is disabled |
| `turnSubmit.silenceMs` | Silence before auto-submit (500–30000 ms) |
| `turnSubmit.vadEnabled` | Use Silero VAD for speech-end detection |

Managed via Config tab or API:

- `GET /api/voice/providers` — returns `{ wakeWords, turnSubmit }`
- `PATCH /api/voice/wake-words` — update wake words and turn submit

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
