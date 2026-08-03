#!/bin/bash
# 터미널 없이 도우미를 백그라운드에서 항상 실행 (로그인 시 자동 시작)
set -e
cd "$(dirname "$0")" || exit 1
HELPER_DIR="$(pwd)"
PROJECT_ROOT="$(cd .. && pwd)"
SERVER="$HELPER_DIR/yt_dlp_server.py"
LABEL="com.uvd.ytdlp-helper"
PLIST_SRC="$HELPER_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/uvd-helper"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp 설치 중…"
  if command -v brew >/dev/null 2>&1; then
    brew install yt-dlp ffmpeg
  else
    pip3 install -U yt-dlp
  fi
fi

# Fill absolute paths into plist
sed \
  -e "s|HELPER_SERVER_PATH|$SERVER|g" \
  -e "s|PROJECT_ROOT|$PROJECT_ROOT|g" \
  -e "s|LOG_DIR|$LOG_DIR|g" \
  "$PLIST_SRC" > "$PLIST_DST"

# Stop old instance if any
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# Kill stray manual server on 8787
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
    sleep 0.5
  fi
fi

launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl start "$LABEL" 2>/dev/null || true

sleep 1
if curl -s --max-time 2 http://127.0.0.1:8787/health | grep -q '"ok"'; then
  echo ""
  echo "✅ 설치 완료 — 이제 터미널을 켤 필요 없습니다."
  echo "   · 로그인하면 자동으로 도우미가 켜집니다"
  echo "   · YouTube / TikTok 다운로드 가능"
  echo "   · 로그: $LOG_DIR"
  echo ""
  echo "끄기:  helper/uninstall_autostart.command 더블클릭"
else
  echo "⚠ 설치는 했지만 응답이 없습니다. 로그를 확인하세요:"
  echo "  $LOG_DIR/uvd-helper.err.log"
  tail -20 "$LOG_DIR/uvd-helper.err.log" 2>/dev/null || true
fi

echo ""
read -r -p "창을 닫으려면 Enter…"
