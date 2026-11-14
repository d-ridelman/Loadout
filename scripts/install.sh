#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
cargo build --release

BIN="$REPO_ROOT/target/release/ctxkit"
HOOK_DIR="$HOME/.claude/hooks"
LOCAL_BIN="$HOME/.local/bin"

mkdir -p "$HOOK_DIR" "$LOCAL_BIN"
cp -f "$BIN" "$HOOK_DIR/ctxkit"
cp -f "$BIN" "$LOCAL_BIN/ctxkit"
chmod +x "$HOOK_DIR/ctxkit" "$LOCAL_BIN/ctxkit"

echo "Installed:"
echo "  $HOOK_DIR/ctxkit"
echo "  $LOCAL_BIN/ctxkit"
echo "Next:"
echo "  $LOCAL_BIN/ctxkit setup --dry-run"
echo "  $LOCAL_BIN/ctxkit setup --with-rules"
