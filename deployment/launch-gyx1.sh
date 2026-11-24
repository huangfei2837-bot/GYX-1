#!/bin/sh
set -eu

BASE_DIR="${GYX1_BASE_DIR:-$HOME/gyx1}"
PID_FILE="$BASE_DIR/run/gyx1.pid"
LOG_FILE="$BASE_DIR/logs/gyx1.log"

mkdir -p "$BASE_DIR/run" "$BASE_DIR/logs" "$BASE_DIR/data"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
fi

nohup "$BASE_DIR/bin/start-gyx1" >> "$LOG_FILE" 2>&1 < /dev/null &
echo "$!" > "$PID_FILE"
