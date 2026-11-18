#!/usr/bin/env bash
# Fix workspace-local lockfile entries and update the Nix dependency hash.
# Requires: node, npm, nix
#
# Usage:
#   ./scripts/update-nix.sh          # fix lockfile + update hash
#   ./scripts/update-nix.sh --check  # verify everything is up to date (CI mode)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$ROOT_DIR/package-lock.json"
HASH_FILE="$ROOT_DIR/nix/npm-deps.hash"
DESKTOP_WEB_HASH_FILE="$ROOT_DIR/nix/desktop-web-deps.hash"

CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

# 1. Fix lockfile (add resolved/integrity for workspace-local entries)
#    Workaround for https://github.com/npm/cli/issues/4460
echo "Fixing lockfile..."
node "$SCRIPT_DIR/fix-lockfile.mjs" "$LOCK_FILE"

# 2. Prefetch deps and compute hash
echo "Prefetching npm dependencies..."

# Resolve prefetch-npm-deps from the same nixpkgs pinned in flake.lock
NIXPKGS_URL="$(node -p "
  const l = JSON.parse(require('fs').readFileSync('$ROOT_DIR/flake.lock', 'utf8'));
  const n = l.nodes.nixpkgs.locked;
  'github:' + n.owner + '/' + n.repo + '/' + n.rev;
")"

STDERR_LOG="$(mktemp)"
trap "rm -f '$STDERR_LOG'" EXIT

if ! NEW_HASH="$(nix shell "${NIXPKGS_URL}#prefetch-npm-deps" -c prefetch-npm-deps "$LOCK_FILE" 2>"$STDERR_LOG")"; then
  echo "ERROR: prefetch-npm-deps failed:" >&2
  tail -20 "$STDERR_LOG" >&2
  exit 1
fi
echo "Computed hash: $NEW_HASH"

# 3. Read current hash from the sidecar file
CURRENT_HASH="$(tr -d '[:space:]' < "$HASH_FILE")"

if [[ "$NEW_HASH" == "$CURRENT_HASH" ]]; then
  echo "Hash is already up to date."
else
  if $CHECK_MODE; then
    echo "ERROR: npmDepsHash is stale."
    echo "  current: $CURRENT_HASH"
    echo "  correct: $NEW_HASH"
    echo "Run ./scripts/update-nix.sh to fix."
    exit 1
  fi

  echo "Updating nix/npm-deps.hash..."
  printf '%s\n' "$NEW_HASH" > "$HASH_FILE"
  echo "Updated: $CURRENT_HASH -> $NEW_HASH"
fi

# 4. Update the desktop-web Bun dependency hash.
#    desktop-web has its own Bun workspace and lockfile. Its dependencies are a
#    fixed-output derivation; build it and, if the hash is stale, read the
#    correct value from Nix's mismatch message.
echo "Checking desktop-web dependency hash..."

DESKTOP_WEB_LOG="$(mktemp)"
trap "rm -f '$STDERR_LOG' '$DESKTOP_WEB_LOG'" EXIT

if nix build "$ROOT_DIR#desktop-web-deps" --no-link --print-out-paths >/dev/null 2>"$DESKTOP_WEB_LOG"; then
  echo "desktop-web dependency hash is already up to date."
else
  NEW_DESKTOP_WEB_HASH="$(grep -oE 'got:[[:space:]]*sha256-[A-Za-z0-9+/=]+' "$DESKTOP_WEB_LOG" \
    | tail -1 | grep -oE 'sha256-[A-Za-z0-9+/=]+')"
  if [[ -z "$NEW_DESKTOP_WEB_HASH" ]]; then
    echo "ERROR: nix build .#desktop-web-deps failed:" >&2
    tail -20 "$DESKTOP_WEB_LOG" >&2
    exit 1
  fi

  CURRENT_DESKTOP_WEB_HASH="$(tr -d '[:space:]' < "$DESKTOP_WEB_HASH_FILE")"

  if [[ "$NEW_DESKTOP_WEB_HASH" == "$CURRENT_DESKTOP_WEB_HASH" ]]; then
    echo "desktop-web dependency hash is already up to date."
  elif $CHECK_MODE; then
    echo "ERROR: nix/desktop-web-deps.hash is stale." >&2
    echo "  current: $CURRENT_DESKTOP_WEB_HASH" >&2
    echo "  correct: $NEW_DESKTOP_WEB_HASH" >&2
    echo "Run ./scripts/update-nix.sh to fix." >&2
    exit 1
  else
    echo "Updating nix/desktop-web-deps.hash..."
    printf '%s\n' "$NEW_DESKTOP_WEB_HASH" > "$DESKTOP_WEB_HASH_FILE"
    echo "Updated: $CURRENT_DESKTOP_WEB_HASH -> $NEW_DESKTOP_WEB_HASH"
  fi
fi
