# 13 — Voice Provider Configuration

How Cursor Voice selects, configures, and secures speech providers (OpenAI,
Gemini, Anthropic, Amazon Bedrock).

## Design (three layers)

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1 — Catalog (provider_keys.ts)                           │
│  Fixed list of provider IDs, env key schemas, known models       │
│  Shipped with the bridge; not user-editable                     │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2 — Viability (.env)                                     │
│  Which providers *can* run — keys present and pass validation     │
│  Detected at runtime; never exposed to the web app              │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3 — Preferences (config.json)                              │
│  Registered providers, model lists, default provider/model      │
│  Managed via Settings in the PWA or by editing config.json      │
└─────────────────────────────────────────────────────────────────┘
```

**Why split this way**

- **Secrets stay in `.env`** — chmod 600, never committed, never returned by API.
- **Preferences stay in `config.json`** — safe to back up; no API keys.
- **Catalog stays in code** — one place to add a new provider ID or known model.

## Provider catalog

| ID | Display name | Env keys | Token mint status |
| --- | --- | --- | --- |
| `openai` | OpenAI | `OPENAI_API_KEY` | Implemented (WebRTC GA) |
| `gemini` | Google Gemini | `GEMINI_API_KEY` | Stub |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | Stub |
| `amazon_bedrock` | Amazon Bedrock | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (optional) | Implemented (bridge WS relay) |

Known models and env validation rules live in `src/realtime/provider_keys.ts`.

### Recommended speech-to-speech models (cost vs quality)

| Provider | Model ID | Tier | Notes |
| --- | --- | --- | --- |
| OpenAI | `gpt-realtime-mini` | $ | Default — best cost/performance for PTT |
| OpenAI | `gpt-4o-mini-realtime-preview` | $ | Preview mini realtime |
| OpenAI | `gpt-realtime` | $$ | Full GA model — best instruction following |
| Gemini | `gemini-2.5-flash-native-audio-preview-12-2025` | $ | Native audio live (stub mint) |
| Bedrock | `amazon.nova-2-sonic-v1:0` | $$ | Nova 2 Sonic — bridge relay |
| Bedrock | `amazon.nova-sonic-v1:0` | $$ | Nova Sonic v1 |

OpenAI uses browser WebRTC. Bedrock uses `/ws/voice` on the bridge (AWS keys never on the phone).

## config.json shape

```json
{
  "settings": {
    "voice": {
      "defaultProvider": "openai",
      "providers": {
        "openai": {
          "defaultModel": "gpt-4o-realtime-preview",
          "models": [
            { "id": "gpt-4o-realtime-preview", "label": "GPT-4o Realtime Preview", "builtin": true }
          ]
        }
      }
    }
  }
}
```

- **`defaultProvider`** — used for `POST /api/realtime/token`.
- **`providers`** — only *registered* providers appear here.
- **`models`** — user can add custom models or remove non-default ones.
- **`builtin: true`** — seeded from catalog; user can still delete from list.

Legacy configs with `voiceProvider` + `realtimeModel` are migrated automatically
on load.

## Voice system prompt (`settings.voice.systemPrompt`)

The Nova/OpenAI voice model instructions are **not hardcoded** in `session.ts`.
Edit them in `config.json`:

```json
{
  "settings": {
    "voice": {
      "systemPrompt": {
        "activationRules": "## Activation rules\\n- You are inactive until...",
        "template": "You are a messenger...\\n\\n{{ACTIVATION_RULES}}\\n..."
      }
    }
  }
}
```

**Placeholders** (substituted at token mint — do not remove unless intentional):

| Placeholder | Source |
| --- | --- |
| `{{ACTIVATION_RULES}}` | `systemPrompt.activationRules` (after wake-word substitution) |
| `{{PROJECT_CATALOG}}` | Enabled projects from the registry (names + aliases only) |
| `{{WAKE_START}}` | `settings.voice.wakeWords.start` |
| `{{WAKE_STOP}}` | `settings.voice.wakeWords.stop` |

Fresh installs and migrations without `systemPrompt` copy defaults from
`config/voice-system-prompt.json`. After editing `config.json`, restart the bridge
and start a new voice session (prompt is baked into the ephemeral token).

## Viability rules

A provider is **viable** when every required env key (from `provider_keys.ts`) is:

1. Non-empty in `process.env` / `.env`
2. At least `minLength` characters (optional keys may be empty)

Registration and “set as default” require viability.

## API (all require app token)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/voice/providers` | Catalog + configured state (no secrets) |
| POST | `/api/voice/providers` | Register `{ id }` |
| DELETE | `/api/voice/providers/:id` | Unregister |
| PUT | `/api/voice/default-provider` | `{ id }` |
| PATCH | `/api/voice/providers/:id/default-model` | `{ modelId }` |
| POST | `/api/voice/providers/:id/models` | `{ id, label? }` |
| DELETE | `/api/voice/providers/:id/models/:modelId` | Remove model |
| PUT | `/api/voice/providers/:id/keys` | `{ keys: { ENV_VAR: "value" } }` — write-only |

Key updates write to `.env`, reload config, reset the cached voice provider, and
audit env var **names** only (never values).

## Web app (Settings → Voice providers)

- See all catalog providers with key status
- Register viable providers; remove registered ones
- Set default provider and default model
- Add/remove models (catalog chips or custom IDs)
- Update API keys (password fields, never pre-filled)

## Security

- Backend **never** returns secret values.
- Provider allowlist enforced server-side (`provider_keys.ts`).
- Model IDs validated on add; default model must exist in the provider's list.
