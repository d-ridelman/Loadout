#!/usr/bin/env bash
set -euo pipefail

# Context Toolkit lives in the Loadout Cargo workspace (crates/context-toolkit): the lock file and target are at the repository root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
cargo build --release -p context-toolkit

BIN="$REPO_ROOT/target/release/context-toolkit"
HOOK_DIR="$HOME/.claude/hooks"
LOCAL_BIN="$HOME/.local/bin"

mkdir -p "$HOOK_DIR" "$LOCAL_BIN"
cp -f "$BIN" "$HOOK_DIR/context-toolkit"
cp -f "$BIN" "$LOCAL_BIN/context-toolkit"
chmod +x "$HOOK_DIR/context-toolkit" "$LOCAL_BIN/context-toolkit"

echo "Installed:"
echo "  $HOOK_DIR/context-toolkit"
echo "  $LOCAL_BIN/context-toolkit"
echo "Next:"
echo "  $LOCAL_BIN/context-toolkit setup --dry-run"
echo "  $LOCAL_BIN/context-toolkit setup --with-rules"
