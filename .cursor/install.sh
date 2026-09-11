#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Universal Video Downloader.
#
# The browser extension itself is plain JS/HTML/CSS and needs no build. The
# repository's tests and the local yt-dlp helper only require:
#   - node    (JS unit/syntax smoke checks)          — from the base image
#   - python3 (helper server + smoke driver)          — from the base image
#   - ffmpeg/ffprobe (HLS/DASH merge + integrity gate) — from the base image
#   - yt-dlp  (the actual downloader the helper drives) — installed here
set -euo pipefail

LOCAL_BIN="$HOME/.local/bin"
YTDLP="$LOCAL_BIN/yt-dlp"
mkdir -p "$LOCAL_BIN"

# yt-dlp: standalone Linux binary. Chosen over pip so `yt-dlp -U` self-update
# (which the helper exposes) works, and to avoid PEP 668 externally-managed
# environment errors. Only downloads when missing so re-runs stay fast.
if [ ! -x "$YTDLP" ]; then
  echo "[install] downloading yt-dlp standalone binary…"
  curl -fsSL --retry 4 --retry-delay 2 \
    -o "$YTDLP" \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
  chmod +x "$YTDLP"
else
  echo "[install] yt-dlp already present: $YTDLP"
fi

# Fail fast if the base image is missing a required system toolchain.
missing=0
for tool in node python3 ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[install] ERROR: required tool not found: $tool" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

echo "[install] node    $(node --version)"
echo "[install] python3 $(python3 --version)"
echo "[install] ffmpeg  $(ffmpeg -version | head -n1)"
echo "[install] yt-dlp  $("$YTDLP" --version)"
echo "[install] done."
