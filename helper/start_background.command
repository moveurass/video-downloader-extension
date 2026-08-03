#!/bin/bash
# 터미널 창 없이 한 번 실행 (로그인 자동 시작은 install_autostart.command 권장)
cd "$(dirname "$0")/.." || exit 1
LOG_DIR="$HOME/Library/Logs/uvd-helper"
mkdir -p "$LOG_DIR"

# Already running?
if curl -s --max-time 1 http://127.0.0.1:8787/health 2>/dev/null | grep -q '"ok"'; then
  echo "이미 실행 중입니다 (http://127.0.0.1:8787)"
  read -r -p "Enter…"
  exit 0
fi

nohup /usr/bin/python3 helper/yt_dlp_server.py \
  >>"$LOG_DIR/uvd-helper.log" 2>>"$LOG_DIR/uvd-helper.err.log" &
sleep 0.8
if curl -s --max-time 2 http://127.0.0.1:8787/health | grep -q '"ok"'; then
  echo "✅ 백그라운드에서 시작됨 (터미널 닫아도 유지)"
else
  echo "시작 실패 — $LOG_DIR/uvd-helper.err.log 확인"
fi
read -r -p "Enter…"
