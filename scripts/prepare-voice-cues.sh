#!/usr/bin/env bash
# Download Kenney UI Audio (CC0) and export voice pipeline cues as MP3.
#
# Sound mapping (UX rationale):
#   listening — rollover4: short bright beep when mic opens (Siri/Alexa-style activation earcon)
#   sent      — click3:      soft boop when a turn is submitted (positive release / confirmation)
#   cancel    — switch2:     toggle-off when user aborts without sending (power-down / dismiss)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/public/sounds"
TMP="$(mktemp -d)"
ZIP="$TMP/kenney-ui-audio.zip"

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

command -v ffmpeg >/dev/null || { echo "ffmpeg required" >&2; exit 1; }

curl -fsSL "https://github.com/Calinou/kenney-ui-audio/archive/refs/heads/master.zip" -o "$ZIP"
unzip -q "$ZIP" -d "$TMP"

SRC="$TMP/kenney-ui-audio-master/addons/kenney_ui_audio"
mkdir -p "$OUT"

ffmpeg -y -i "$SRC/rollover4.wav" -filter:a "volume=2.8,highpass=f=120" -codec:a libmp3lame -qscale:a 2 "$OUT/listening.mp3"
ffmpeg -y -i "$SRC/click3.wav" -filter:a "volume=3.5,highpass=f=80" -codec:a libmp3lame -qscale:a 2 "$OUT/sent.mp3"
ffmpeg -y -i "$SRC/switch2.wav" -filter:a "volume=2.8,highpass=f=100" -codec:a libmp3lame -qscale:a 2 "$OUT/cancel.mp3"
cp "$SRC/LICENSE.txt" "$OUT/LICENSE.txt"

echo "Voice cues written to $OUT"
