#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"
exec "$SCRIPT_DIR/runtime/node" "$SCRIPT_DIR/server.mjs" "$@"
