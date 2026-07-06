#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VENV_DIR=${LINKR_TERM_BUILD_VENV:-/tmp/linkr-ble-terminal-build}

cd "$ROOT_DIR"
rm -rf build/linkr-ble-terminal dist/linkr-ble-terminal linkr-ble-terminal.spec

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV_DIR/bin/python" -m pip install bleak pyinstaller
"$VENV_DIR/bin/pyinstaller" --onefile --clean --name linkr-ble-terminal \
	tools/linkr_ble_terminal.py

echo "Built: $ROOT_DIR/dist/linkr-ble-terminal"
