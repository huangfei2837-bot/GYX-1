#!/bin/sh
set -eu

BASE_DIR="${GYX1_TAILSCALE_DIR:-$HOME/tailscale}"
BIN_DIR="${GYX1_TAILSCALE_BIN:-$HOME/.local/tailscale}"
PID_FILE="$BASE_DIR/run/tailscaled.pid"
SOCKET_FILE="$BASE_DIR/tailscaled.sock"
LOG_FILE="$BASE_DIR/logs/tailscaled.log"

mkdir -p "$BASE_DIR/run" "$BASE_DIR/logs" "$BASE_DIR/state"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    exit 0
  fi
fi

nohup "$BIN_DIR/tailscaled" \
  --tun=userspace-networking \
  --state="$BASE_DIR/state/tailscaled.state" \
  --statedir="$BASE_DIR/state" \
  --socket="$SOCKET_FILE" \
  --no-logs-no-support \
  >> "$LOG_FILE" 2>&1 < /dev/null &
echo "$!" > "$PID_FILE"
