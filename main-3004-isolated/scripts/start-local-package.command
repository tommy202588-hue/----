#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"
exec /bin/sh "$DIR/start-local.sh" "$@"
