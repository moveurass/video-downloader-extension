#!/bin/bash
# Double-click on macOS, or: ./helper/start.command
cd "$(dirname "$0")/.." || exit 1
echo "▶ Universal Video Downloader — yt-dlp helper"
echo ""

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp가 없습니다. 설치를 시도합니다…"
  if command -v brew >/dev/null 2>&1; then
    brew install yt-dlp
  elif command -v pip3 >/dev/null 2>&1; then
    pip3 install -U yt-dlp
  else
    echo "수동 설치:  pip3 install -U yt-dlp"
    echo "또는:        brew install yt-dlp"
    read -r -p "계속하려면 Enter…"
  fi
fi

echo "저장 위치: ~/Downloads/VideoDownloader"
echo "헬퍼 주소: http://127.0.0.1:8787"
echo "종료: Ctrl+C"
echo ""
exec python3 helper/yt_dlp_server.py
