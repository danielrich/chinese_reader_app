#!/usr/bin/env bash
# sync-db-to-linux.sh
#
# Copies the Chinese Reader SQLite database from this Mac to a Linux server.
# SQLite files are fully portable — no conversion needed.
#
# Usage:
#   ./scripts/sync-db-to-linux.sh user@linux-host [remote-path]
#
# Examples:
#   ./scripts/sync-db-to-linux.sh daniel@192.168.1.50
#   ./scripts/sync-db-to-linux.sh daniel@192.168.1.50 /opt/chinese-reader/dictionary.db

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 user@linux-host [remote-path]"
  echo "  remote-path defaults to: ~/chinese-reader/dictionary.db"
  exit 1
fi

REMOTE_HOST="$1"
REMOTE_PATH="${2:-~/chinese-reader/dictionary.db}"

# ── Source DB ─────────────────────────────────────────────────────────────────

MAC_DB="$HOME/Library/Application Support/com.chinesereader.ChineseReader/dictionary.db"

if [[ ! -f "$MAC_DB" ]]; then
  echo "Error: DB not found at: $MAC_DB"
  echo "Has the Tauri app been run at least once?"
  exit 1
fi

DB_SIZE=$(du -sh "$MAC_DB" | cut -f1)
echo "Source: $MAC_DB ($DB_SIZE)"
echo "Target: $REMOTE_HOST:$REMOTE_PATH"
echo ""

# ── Create remote directory if needed ─────────────────────────────────────────

REMOTE_DIR=$(dirname "$REMOTE_PATH")
echo "→ Ensuring remote directory exists: $REMOTE_DIR"
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"

# ── Copy ──────────────────────────────────────────────────────────────────────

echo "→ Copying database..."
scp "$MAC_DB" "$REMOTE_HOST:$REMOTE_PATH"

echo ""
echo "✓ Done. DB is at $REMOTE_HOST:$REMOTE_PATH"
echo ""
echo "Start the server with:"
echo "  ssh $REMOTE_HOST"
echo "  cd \$(dirname $REMOTE_PATH)"
echo "  ./server --db-path $REMOTE_PATH --dist dist --port 3000"
