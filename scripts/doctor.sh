#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Cursor Voice — connectivity doctor (Linux)
#
# Diagnoses why https://<machine>.ts.net might show "Server Not Found".
# Run after setup.sh or when the PWA cannot be reached.
#
# Usage: bash scripts/doctor.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
BLU='\033[0;34m'
BLD='\033[1m'
NC='\033[0m'

pass() { echo -e "${GRN}✔${NC}  $*"; }
fail() { echo -e "${RED}✘${NC}  $*"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "${YEL}!${NC}  $*"; }
info() { echo -e "${BLU}→${NC}  $*"; }

FAILURES=0

echo -e "${BLD}Cursor Voice — connectivity doctor${NC}\n"

# ── 1. Local bridge ───────────────────────────────────────────────────────
ENV_FILE="${PROJECT_DIR}/.env"
PORT=8787
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport; source "$ENV_FILE"; set +o allexport
  PORT="${PORT:-8787}"
fi

if systemctl --user is-active --quiet cursor-voice.service 2>/dev/null; then
  pass "systemd service cursor-voice is running"
else
  fail "systemd service cursor-voice is not running"
  info "Fix: bash scripts/restart.sh"
fi

if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  pass "Bridge responds on http://127.0.0.1:${PORT}/healthz"
else
  fail "Bridge not responding on http://127.0.0.1:${PORT}/healthz"
  info "Fix: journalctl --user -u cursor-voice -n 30"
fi

# ── 2. Tailscale daemon ───────────────────────────────────────────────────
if ! command -v tailscale &>/dev/null; then
  fail "tailscale CLI not found"
  info "Fix: bash scripts/setup.sh"
else
  pass "tailscale CLI installed"
fi

if tailscale status &>/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null || true)"
  pass "Tailscale connected (IP: ${TS_IP:-unknown})"
else
  fail "Tailscale not connected"
  info "Fix: sudo tailscale up"
fi

# ── 3. MagicDNS (hostname resolution) ─────────────────────────────────────
TS_HOST="$(tailscale status --json 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" \
  2>/dev/null || true)"

CORP_DNS="$(tailscale debug prefs 2>/dev/null | grep -o '"CorpDNS": [^,]*' | awk '{print $2}' || true)"

if [[ "$CORP_DNS" == "true" ]]; then
  pass "MagicDNS enabled on tailnet (CorpDNS=true)"
else
  fail "MagicDNS is OFF (CorpDNS=false) — hostnames like *.ts.net will not resolve"
  info "Fix: https://login.tailscale.com/admin/dns → enable MagicDNS"
fi

if [[ -n "$TS_HOST" ]]; then
  if getent hosts "$TS_HOST" &>/dev/null || host "$TS_HOST" &>/dev/null 2>&1; then
    pass "Hostname resolves: ${TS_HOST}"
  else
    fail "Hostname does NOT resolve: ${TS_HOST}"
    info "Enable MagicDNS, then reconnect Tailscale on this device"
  fi
else
  warn "Could not detect Tailscale DNS name"
fi

# ── 4. HTTPS certificates ─────────────────────────────────────────────────
CERT_MSG="$(tailscale cert 2>&1 || true)"
if echo "$CERT_MSG" | grep -qi 'not enabled'; then
  fail "HTTPS certificates not enabled on tailnet"
  info "Fix: https://login.tailscale.com/admin/dns → HTTPS Certificates → Enable"
else
  pass "HTTPS certificate support appears enabled"
fi

# ── 5. Tailscale Serve ────────────────────────────────────────────────────
SERVE_STATUS="$(tailscale serve status 2>&1 || true)"
if echo "$SERVE_STATUS" | grep -qi 'no serve config'; then
  fail "Tailscale Serve is not configured (No serve config)"
  NODE_ID="$(tailscale status --json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('ID',''))" \
    2>/dev/null || true)"
  if [[ -n "$NODE_ID" ]]; then
    info "Step 1 — Enable Serve on tailnet: https://login.tailscale.com/f/serve?node=${NODE_ID}"
  else
    info "Step 1 — Enable Serve: https://login.tailscale.com/admin/acls (Serve must be allowed)"
  fi
  info "Step 2 — Then run: tailscale serve --bg ${PORT}"
elif echo "$SERVE_STATUS" | grep -qi 'not enabled on your tailnet'; then
  fail "Tailscale Serve not enabled on your tailnet"
  info "Fix: visit the enable link printed by 'tailscale serve --bg ${PORT}'"
else
  pass "Tailscale Serve is configured"
  echo "$SERVE_STATUS" | sed 's/^/    /'
fi

# ── 6. End-to-end HTTPS test ──────────────────────────────────────────────
if [[ -n "$TS_HOST" ]]; then
  if curl -sfk --max-time 5 "https://${TS_HOST}/healthz" >/dev/null 2>&1; then
    pass "HTTPS reachable: https://${TS_HOST}/healthz"
  else
    fail "HTTPS NOT reachable: https://${TS_HOST}/healthz"
    info "Complete Serve + MagicDNS + HTTPS cert steps above, then retry"
  fi
fi

# ── 7. config.json runMode ────────────────────────────────────────────────
if [[ -f "${PROJECT_DIR}/config.json" ]]; then
  if grep -q '"runMode": "serve"' "${PROJECT_DIR}/config.json"; then
    pass "config.json runMode is serve"
  else
    warn "config.json runMode is not 'serve' — PWA may point at dev proxy"
    info "Set settings.runMode to \"serve\" in config.json"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo -e "${GRN}${BLD}All checks passed.${NC} Open https://${TS_HOST:-your-machine.ts.net} from a Tailscale-connected device."
else
  echo -e "${RED}${BLD}${FAILURES} check(s) failed.${NC} Fix the items above, then re-run: bash scripts/doctor.sh"
  echo ""
  echo -e "${BLD}Quick fix order:${NC}"
  echo "  1. Enable MagicDNS:     https://login.tailscale.com/admin/dns"
  echo "  2. Enable HTTPS certs:  same page → HTTPS Certificates"
  echo "  3. Enable Serve:        run 'tailscale serve --bg ${PORT}' and follow the link"
  echo "  4. iPhone must have Tailscale app ON and connected to your tailnet"
fi
echo ""
