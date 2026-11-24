#!/bin/sh
set -eu

BASE_DIR="${GYX1_BASE_DIR:-$HOME/gyx1}"
PID_FILE="$BASE_DIR/run/gyx1.pid"

if [ ! -f "$PID_FILE" ]; then
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in 1 2 3 4 5; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
fi
rm -f "$PID_FILE"
