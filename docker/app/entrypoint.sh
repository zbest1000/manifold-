#!/bin/sh
set -e

DATA_DIR="${MANIFOLD_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

# Seed the auto-connect profiles once (the app then owns/updates the file).
if [ ! -f "$DATA_DIR/profiles.json" ] && [ -f /seed/profiles.json ]; then
  cp /seed/profiles.json "$DATA_DIR/profiles.json"
  echo "entrypoint: seeded $DATA_DIR/profiles.json"
fi

# Wait for the broker and OPC UA server so the profile restore connects on the
# first attempt instead of erroring and relying on reconnect.
node /wait-for.js mqtt 1883 opcua 50000 || echo "entrypoint: continuing without all deps ready"

exec node index.js
