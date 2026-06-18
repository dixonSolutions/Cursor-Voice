# Cursor Voice

Self-hosted voice bridge for driving [Cursor's coding agent](https://cursor.com/docs/cli)
(`cursor-agent`) by **speech, from your phone**.

Speak from an iPhone PWA; **Cursor IDE** is the reasoning layer via the
**cursor-voice MCP server** (`speak`, `done`, `next_voice_turn`). Coding work is
delegated to worker agents via `spawn_agent`. Audio uses browser STT/TTS with
Amazon Polly/Transcribe fallback. Networking is private over Tailscale.

## How it works

```
iPhone PWA (Vosk wake + STT + TTS)
        │  /ws/intelligence (app token)
        ▼
Bridge (Node/TS) ── VoiceTurnQueue ── MCP /mcp ──► Cursor voice agent
        │                                              │
        │                                              ▼ spawn_agent
        └──────────────────────────────────────► cursor-agent workers → git
```

**Default workflow:** `cursor_native` — see [`docs/16-mcp-server-cursor-as-brain.md`](./docs/16-mcp-server-cursor-as-brain.md).

**Alternate:** `llm_intelligence` — Claude on Bedrock orchestrates tools.

## Quick start (dev)

```bash
cp config.example.json config.json
cp .env.example .env   # set APP_TOKEN + AWS IAM keys
npm install
npm run dev
```

Open the web URL shown in the terminal (unified port in test mode).

## Host on Windows (one-command setup)

Prerequisites: [Node.js 20 LTS](https://nodejs.org), [Git](https://git-scm.com), [Cursor IDE](https://cursor.com) with `cursor-agent` on PATH.

```powershell
# 1. Clone the repo
git clone https://github.com/dixonSolutions/Cursor-Voice.git
cd Cursor-Voice

# 2. Run setup — installs Tailscale, builds the project, creates .env,
#    installs a Windows Service (NSSM), and configures tailscale serve.
#    Run in an elevated (Administrator) PowerShell terminal.
.\scripts\setup.ps1
```

After setup, the script prints your `APP_TOKEN`. Enter it in the PWA settings screen.

**After initial setup:**

```powershell
# Rebuild and restart after code changes
.\scripts\restart.ps1

# Diagnose connectivity issues
.\scripts\doctor.ps1
```

> **Tailscale required.** The setup script installs Tailscale via winget if it is not present.
> After installation, sign in to Tailscale and enable **HTTPS Certificates** in the
> [Tailscale admin console](https://login.tailscale.com/admin/dns) to get a trusted HTTPS URL.

## Host on Linux (one-command setup)

Prerequisites: Node.js 20 LTS, Git, Cursor IDE with `cursor-agent` on PATH.

```bash
# 1. Clone the repo
git clone https://github.com/dixonSolutions/Cursor-Voice.git
cd Cursor-Voice

# 2. Run setup — installs Tailscale, builds, creates .env,
#    installs a systemd user service, and configures tailscale serve.
bash scripts/setup.sh
```

**After initial setup:**

```bash
# Rebuild and restart after code changes
bash scripts/restart.sh

# Diagnose connectivity issues
bash scripts/doctor.sh
```

## Documentation

Full design in [`docs/`](./docs) — start with [`docs/README.md`](./docs/README.md).

| Doc | Topic |
| --- | --- |
| [`02-architecture.md`](./docs/02-architecture.md) | System architecture |
| [`06-voice-audio-webrtc.md`](./docs/06-voice-audio-webrtc.md) | STT, TTS, VAD, wake words |
| [`16-mcp-server-cursor-as-brain.md`](./docs/16-mcp-server-cursor-as-brain.md) | Default Cursor voice workflow |
| [`11-mcp-tool-surface.md`](./docs/11-mcp-tool-surface.md) | MCP tool inventory |

## Stack

- **Bridge:** Node.js 20+, TypeScript, Fastify, MCP SDK, SQLite
- **Web app:** Angular PWA + vanilla TS voice modules (Vosk, Silero VAD)
- **Voice I/O:** WebKit STT/TTS; Amazon Polly/Transcribe fallback
- **Reasoning:** Cursor IDE (`cursor_native`) or Bedrock Claude (`llm_intelligence`)
- **Executor:** `cursor-agent` CLI
- **Network:** Tailscale

## Configuration

- **`.env`** — `APP_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- **`config.json`** — projects, wake words, workflow, operational settings

See [`docs/07-data-and-deployment.md`](./docs/07-data-and-deployment.md).
