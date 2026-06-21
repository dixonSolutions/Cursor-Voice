# Heartbeat self-hosting

Heartbeat is an optional in-process sector that keeps a self-hosted Cursor Voice bridge up to date: git fetch/pull, dependency install, production build, and service restart — with every step logged to SQLite and the Config tab.

Disabled by default. Manual runs are always available via the API or Config UI.

## Config (`settings.heartbeat` in config.json)

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Master switch for scheduled ticks |
| `intervalMs` | `900000` | Scheduler interval (min 60s) |
| `autoPull` | `true` | Pull when behind upstream |
| `autoInstallDeps` | `true` | Run `npm install` when lockfile changes after pull |
| `autoBuild` | `true` | Run `npm run build` |
| `autoRestart` | `true` | Restart after build (watch.path or `scripts/restart.sh`) |
| `abortOnLocalChanges` | `true` | Skip pull when working tree is dirty |
| `branch` | _(current)_ | Optional branch override |
| `repoDir` | _(cwd)_ | Optional repository root |

See [config.example.json](../config.example.json).

## Pipeline

1. **git status** — detect dirty tree, ahead/behind
2. **git fetch** — always attempted when not aborted for local changes
3. **git pull** — when `autoPull` and behind upstream
4. **npm install** — when lockfile hash changed and `autoInstallDeps`
5. **npm run build** — when `autoBuild`
6. **restart** — when `autoRestart` and build ran; prefers `cursor-voice-watch.path`, else detached `scripts/restart.sh --no-build`
7. **health_check** — GET `/healthz` on configured `PORT`

Each step writes a row to `heartbeat_event` and an audit entry.

## Admin API (Bearer `APP_TOKEN`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/heartbeat` | Settings + live status (git snapshot, last run) |
| PATCH | `/api/admin/heartbeat` | Update settings; reconciles scheduler |
| POST | `/api/admin/heartbeat/run` | Start manual run (409 if already running) |
| GET | `/api/admin/heartbeat/events?limit=` | Recent step log |
| POST | `/api/admin/heartbeat/install` | Spawn `scripts/install-systemd.sh` in background |

## Config tab

Open **Config → Heartbeat** to:

- Toggle scheduler and each pipeline step
- Set interval, branch, and repo directory
- View git status and last run outcome
- **Run now** — manual heartbeat
- **Install hosting (systemd)** — user-level service + watch path
- Browse recent event log

Hosting run mode / ports remain under **Config → Hosting & Network**.

## Safety

- Scheduled runs no-op when `enabled` is false
- Local changes block pull when `abortOnLocalChanges` is true
- Individual steps can be disabled (`autoPull`, `autoInstallDeps`, etc.)
- Subprocess argv is fixed (`npm`, `bash`, `systemctl`); no user input is passed to shells
- Failures are logged; the bridge process is not terminated on heartbeat errors

## Code

- [`src/heartbeat/index.ts`](../src/heartbeat/index.ts) — orchestrator + scheduler
- [`src/routes/heartbeat.ts`](../src/routes/heartbeat.ts) — admin routes
- [`src/state/heartbeatEvents.ts`](../src/state/heartbeatEvents.ts) — SQLite log
