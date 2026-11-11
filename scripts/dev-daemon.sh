#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export NEOLIX_LISTEN="${NEOLIX_LISTEN:-127.0.0.1:6768}"
configure_dev_neolix_home

if [ -z "${NEOLIX_LOCAL_MODELS_DIR}" ]; then
  export NEOLIX_LOCAL_MODELS_DIR="$HOME/.neox/models/local-speech"
  mkdir -p "$NEOLIX_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Neolix Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${NEOLIX_HOME}"
echo "  Models:  ${NEOLIX_LOCAL_MODELS_DIR}"
echo "  Listen:  ${NEOLIX_LISTEN}"
echo "══════════════════════════════════════════════════════"

export NEOLIX_CORS_ORIGINS="${NEOLIX_CORS_ORIGINS:-*}"
export NEOLIX_NODE_INSPECT="${NEOLIX_NODE_INSPECT:---inspect=0}"

if [ "${NEOLIX_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
