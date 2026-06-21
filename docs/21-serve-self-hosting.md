# Serve self-hosting

Serve is an optional in-process sector that keeps a self-hosted Cursor Voice bridge up to date: git fetch/pull, dependency install, production build, and service restart — with every step logged to SQLite and the Config tab.

Disabled by default. Manual actions and full pipeline runs are always available via the API or Config UI.

## Config (`settings.serve` in config.json)

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

Legacy `settings.heartbeat` is migrated to `settings.serve` on load.

See [config.example.json](../config.example.json).

## Pipeline (full run)

1. **git status** — detect dirty tree, ahead/behind
2. **git fetch** — always attempted when not aborted for local changes
3. **git pull** — when `autoPull` and behind upstream
4. **npm install** — when lockfile hash changed and `autoInstallDeps`
5. **npm run build** — when `autoBuild`
6. **restart** — when `autoRestart` and build ran; prefers `cursor-voice-watch.path`, else detached `scripts/restart.sh --no-build`
7. **health_check** — GET `/healthz` on configured `PORT`

Each step writes a row to `serve_event` and an audit entry.

## Admin API (Bearer `APP_TOKEN`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/serve` | Settings + live status (git snapshot, last run) |
| PATCH | `/api/admin/serve` | Update settings; reconciles scheduler |
| POST | `/api/admin/serve/run` | Start full manual run (409 if already running) |
| POST | `/api/admin/serve/action` | Run single action: `pull`, `deps`, `build`, `restart`, `health` |
| GET | `/api/admin/serve/events?limit=` | Recent step log |
| POST | `/api/admin/serve/install` | Spawn `scripts/install-systemd.sh` in background |

Hosting run mode / ports remain at `/api/admin/hosting` and are edited in the Serve hub **Network** tab.

## Config tab

Open **Config → Serve** — a tabbed hub with:

- **Status** — running/idle, scheduler, last run, git snapshot; Refresh + Health check
- **Actions** — Run full update; individual Git pull, Install deps, Build, Restart, Health check, Install hosting (systemd)
- **Network** — run mode, test/serve ports, public URL (formerly Hosting & Network)
- **Automation** — scheduler, pipeline toggles, branch/repo directory
- **Activity** — recent serve event log

## Safety

- Scheduled runs no-op when `enabled` is false
- Local changes block pull when `abortOnLocalChanges` is true (full run; manual pull uses force)
- Individual steps can be disabled (`autoPull`, `autoInstallDeps`, etc.)
- Subprocess argv is fixed (`npm`, `bash`, `systemctl`); no user input is passed to shells
- Failures are logged; the bridge process is not terminated on serve errors
- Only one serve operation at a time (409 if busy)

## Code

- [`src/serve/index.ts`](../src/serve/index.ts) — orchestrator, scheduler, granular actions
- [`src/routes/serve.ts`](../src/routes/serve.ts) — admin routes
- [`src/state/serveEvents.ts`](../src/state/serveEvents.ts) — SQLite log
