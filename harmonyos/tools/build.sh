#!/bin/sh

set -eu

HARMONY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_DIR=$(CDPATH= cd -- "$HARMONY_DIR/.." && pwd)
DEVECO_HOME=${DEVECO_STUDIO_HOME:-/Applications/DevEco-Studio.app}

if [ ! -d "$DEVECO_HOME/Contents" ]; then
  printf 'DevEco Studio not found: %s\n' "$DEVECO_HOME" >&2
  exit 1
fi

NODE_HOME="$DEVECO_HOME/Contents/tools/node"
JAVA_HOME="$DEVECO_HOME/Contents/jbr/Contents/Home"
export NODE_HOME
export JAVA_HOME
export DEVECO_SDK_HOME="$DEVECO_HOME/Contents/sdk"
export PATH="$JAVA_HOME/bin:$NODE_HOME/bin:$DEVECO_HOME/Contents/tools/ohpm/bin:$PATH"

if [ "${1:-}" != "--skip-web" ]; then
  cd "$REPO_DIR/mobile"
  npm run build:harmony
fi

cd "$HARMONY_DIR"
exec "$DEVECO_HOME/Contents/tools/hvigor/bin/hvigorw" \
  --mode module \
  -p product=default \
  -p module=entry@default \
  --no-daemon \
  assembleHap
