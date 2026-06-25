# Split-host SSH tunnel (Tailscale front door)

When Cursor Voice runs on a **remote** machine (VM, incus container, etc.) but
**Tailscale Serve** runs on your laptop or home PC, you need a persistent SSH
port forward on the Tailscale machine.

## Topology

```
Phone / browser
  → https://eva.tail14805e.ts.net     (Tailscale Serve on eva)
  → http://127.0.0.1:15671            (SSH tunnel, local)
  → ssh -L … borys@remote:5671
  → nginx :5671 on remote              (PWA + proxy)
  → cursor-voice :1234                 (bridge API)
```

The bridge `publicBaseUrl` stays the Tailscale HTTPS URL. The bridge itself runs
on the remote host; only the tunnel + Serve live on eva.

## One-time setup (Tailscale machine — eva)

1. **SSH key auth** to the remote host (passwordless `ssh user@host`).

2. **Install the tunnel service** from this repo:

   ```bash
   cd /path/to/CursorVoice
   bash scripts/install-remote-tunnel.sh \
     --remote borys@100.118.238.2 \
     --remote-port 5671 \
     --local-port 15671
   ```

   This writes `~/.config/cursor-voice/tunnel.env` and enables
   `cursor-voice-tunnel.service` (systemd user, `Restart=always`).

3. **Point Tailscale Serve** at the local tunnel port (once per machine):

   ```bash
   tailscale serve --bg http://127.0.0.1:15671
   ```

4. **Verify:**

   ```bash
   bash scripts/doctor.sh
   curl -s https://eva.tail14805e.ts.net/healthz
   ```

## Operations

| Task | Command |
|------|---------|
| Status | `systemctl --user status cursor-voice-tunnel` |
| Logs | `journalctl --user -u cursor-voice-tunnel -f` |
| Restart | `systemctl --user restart cursor-voice-tunnel` |
| Reinstall | `bash scripts/install-remote-tunnel.sh` |

Config file: `~/.config/cursor-voice/tunnel.env` (see
[`scripts/remote-tunnel.env.example`](../scripts/remote-tunnel.env.example)).

## Remote host (container)

Split-port nginx + bridge setup is unchanged — see
[`scripts/nginx-cursor-voice.conf.example`](../scripts/nginx-cursor-voice.conf.example)
and incus proxy `host5671 → container 5671`.

## Why the tunnel dies

Manual `ssh -f -N -L …` exits when the session drops or the machine reboots.
The systemd user unit keeps it alive with `Restart=always` and SSH
`ServerAliveInterval`.

## Related

- [`07-data-and-deployment.md`](./07-data-and-deployment.md) — run modes and ports
- [`21-serve-self-hosting.md`](./21-serve-self-hosting.md) — bridge auto-update on the remote host
