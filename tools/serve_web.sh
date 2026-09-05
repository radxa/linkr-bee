#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
PORT=${1:-8765}

cd "$ROOT_DIR"
echo "Serving Web Bluetooth terminal at http://127.0.0.1:$PORT/"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory web
