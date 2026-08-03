#!/bin/bash
# 백그라운드 자동 실행 제거
LABEL="com.uvd.ytdlp-helper"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"

# Stop anything on 8787
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    # shellcheck disable=SC2086
    kill $PIDS 2>/dev/null || true
  fi
fi

echo "자동 실행을 해제했습니다. YouTube/TikTok은 도우미 없이는 받을 수 없습니다."
read -r -p "창을 닫으려면 Enter…"
