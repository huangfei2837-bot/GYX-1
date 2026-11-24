#!/bin/sh
set -eu

BASE_DIR="${GYX1_BASE_DIR:-$HOME/gyx1}"
CREDENTIALS_FILE="${GYX1_CREDENTIALS_FILE:-$HOME/GYX1-MQTT-credentials.txt}"
NODE_BIN="${GYX1_NODE_BIN:-$HOME/.local/node/bin/node}"

if [ ! -x "$NODE_BIN" ]; then
  echo "Node.js not found: $NODE_BIN" >&2
  exit 1
fi

if [ ! -r "$CREDENTIALS_FILE" ]; then
  echo "MQTT credentials not found: $CREDENTIALS_FILE" >&2
  exit 1
fi

# The backend account is the final Username/Password pair in the protected file.
MQTT_USERNAME="$(awk -F': ' '/^Username:/ { value=$2 } END { print value }' "$CREDENTIALS_FILE")"
MQTT_PASSWORD="$(awk -F': ' '/^Password:/ { value=$2 } END { print value }' "$CREDENTIALS_FILE")"

if [ -z "$MQTT_USERNAME" ] || [ -z "$MQTT_PASSWORD" ]; then
  echo "Backend MQTT credentials are incomplete" >&2
  exit 1
fi

export GYX1_HOST="${GYX1_HOST:-0.0.0.0}"
export GYX1_PORT="${GYX1_PORT:-8080}"
export GYX1_DB="${GYX1_DB:-$BASE_DIR/data/gyx1.sqlite}"
export GYX1_ALLOWED_ORIGIN="${GYX1_ALLOWED_ORIGIN:-*}"
export GYX1_MQTT_URL="${GYX1_MQTT_URL:-mqtt://127.0.0.1:1883}"
export GYX1_MQTT_TOPIC="${GYX1_MQTT_TOPIC:-gyx1/+/telemetry}"
export GYX1_MQTT_USERNAME="$MQTT_USERNAME"
export GYX1_MQTT_PASSWORD="$MQTT_PASSWORD"

exec "$NODE_BIN" "$BASE_DIR/current/backend/server.js"
