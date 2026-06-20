#!/usr/bin/env bash
# Generate Web Push VAPID keys for .env
set -euo pipefail
npx web-push generate-vapid-keys --json
