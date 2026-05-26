#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$HOME/.local/share/com.chinesereader.ChineseReader/dictionary.db"
BACKUP_DIR=""
SERVICE_NAME="chinese-reader"
BUILD=1
RESTART_SERVICE=1

usage() {
  cat <<USAGE
Usage: $0 [options]

Back up the Chinese Reader SQLite database, apply schema migrations, and
optionally restart the systemd daemon.

Options:
  --db-path PATH       SQLite database path.
                       Default: $DB_PATH
  --backup-dir DIR    Backup directory.
                       Default: <db directory>/backups
  --service NAME      systemd service name. Default: $SERVICE_NAME
  --no-build          Skip npm/cargo release builds.
  --no-restart        Do not stop/start systemd service.
  -h, --help          Show this help.

Examples:
  scripts/backup-and-migrate-db.sh
  scripts/backup-and-migrate-db.sh --db-path /opt/chinese-reader/dictionary.db --service chinese-reader
  scripts/backup-and-migrate-db.sh --no-restart
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-path)
      DB_PATH="${2:?--db-path requires a value}"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="${2:?--backup-dir requires a value}"
      shift 2
      ;;
    --service)
      SERVICE_NAME="${2:?--service requires a value}"
      shift 2
      ;;
    --no-build)
      BUILD=0
      shift
      ;;
    --no-restart)
      RESTART_SERVICE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

if [[ -z "$BACKUP_DIR" ]]; then
  BACKUP_DIR="$(dirname "$DB_PATH")/backups"
fi

mkdir -p "$BACKUP_DIR"

if [[ "$BUILD" -eq 1 ]]; then
  (cd "$ROOT_DIR" && npm run build)
  (cd "$ROOT_DIR/src-tauri" && cargo build --release --bin server --bin migrate)
fi

SERVICE_WAS_ACTIVE=0
if [[ "$RESTART_SERVICE" -eq 1 ]] && command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    SERVICE_WAS_ACTIVE=1
    sudo systemctl stop "$SERVICE_NAME"
  fi
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_path="$BACKUP_DIR/dictionary-$timestamp.db"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$backup_path'"
else
  cp "$DB_PATH" "$backup_path"
  [[ -f "$DB_PATH-wal" ]] && cp "$DB_PATH-wal" "$backup_path-wal"
  [[ -f "$DB_PATH-shm" ]] && cp "$DB_PATH-shm" "$backup_path-shm"
fi

"$ROOT_DIR/src-tauri/target/release/migrate" --db-path "$DB_PATH"

if [[ "$RESTART_SERVICE" -eq 1 ]] && command -v systemctl >/dev/null 2>&1; then
  if [[ "$SERVICE_WAS_ACTIVE" -eq 1 ]]; then
    sudo systemctl start "$SERVICE_NAME"
  else
    echo "Service was not active before migration; leaving it stopped."
  fi
fi

echo "Backup written: $backup_path"
echo "Done."
