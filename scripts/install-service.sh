#!/usr/bin/env bash
set -Eeuo pipefail

# Existing LAN deployment paths are deliberately retained for import tools.
ROOT=/home/daniel/exper/chinese_reader_app
BINARY="$ROOT/src-tauri/target/release/server"
DB_DIR=/home/daniel/.local/share/com.chinesereader.ChineseReader
DB="$DB_DIR/dictionary.db"
SERVICE=/etc/systemd/system/chinese-reader.service
ACCOUNT=chinese-reader
ORIGINS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-binary) BINARY="${2:?--server-binary requires a path}"; shift 2 ;;
    --origins) ORIGINS="${2:?--origins requires a comma-separated origin list}"; shift 2 ;;
    *) echo "Usage: $0 [--server-binary PATH] [--origins ORIGIN,ORIGIN]" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'Run this installer with sudo.' >&2; exit 1; }
for tool in setfacl getfacl runuser curl systemd-analyze; do
  command -v "$tool" >/dev/null || { echo "Missing required command: $tool" >&2; exit 1; }
done
for path in "$BINARY" "$DB" "$ROOT/dist/index.html" "$ROOT/chasmfiend.local.pem" "$ROOT/chasmfiend.local-key.pem"; do
  [[ -f "$path" ]] || { echo "Missing file: $path" >&2; exit 1; }
done
if [[ -z "$ORIGINS" && -f /etc/chinese-reader/origins.env ]]; then
  # Preserve the existing reviewed configuration; never source an env file as shell code.
  ORIGINS=$(sed -n 's/^CHINESE_READER_ALLOWED_ORIGINS=//p' /etc/chinese-reader/origins.env)
fi
if [[ -z "$ORIGINS" ]]; then
  echo 'First install requires --origins with the exact LAN and Tailscale origins.' >&2
  exit 1
fi
# Only origin characters are accepted here, so values cannot inject unit/env lines.
origin_pattern='^https?://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]+)?$'
[[ "$ORIGINS" != ,* && "$ORIGINS" != *, && "$ORIGINS" != *,,* ]] || { echo 'Empty origin entry.' >&2; exit 1; }
IFS=, read -r -a origin_list <<< "$ORIGINS"
for origin in "${origin_list[@]}"; do
  [[ "$origin" =~ $origin_pattern ]] || {
    echo 'Origins must be comma-separated http(s)://host[:port] values, without trailing slashes.' >&2
    exit 1
  }
done
[[ "$ORIGINS" != *$'\n'* && "$ORIGINS" != *$'\r'* ]] || exit 1

BACKUP="/var/backups/chinese-reader-security/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$BACKUP"
[[ ! -f "$SERVICE" ]] || cp -a "$SERVICE" "$BACKUP/chinese-reader.service"
[[ ! -d /etc/chinese-reader ]] || cp -a /etc/chinese-reader "$BACKUP/config"
[[ ! -f /opt/chinese-reader/server ]] || cp -a /opt/chinese-reader/server "$BACKUP/server"
getfacl -p /home/daniel /home/daniel/.local /home/daniel/.local/share "$DB_DIR" "$DB" > "$BACKUP/access.acl"
for sidecar in "$DB-wal" "$DB-shm"; do
  [[ ! -f "$sidecar" ]] || getfacl -p "$sidecar" >> "$BACKUP/access.acl"
done

WAS_ACTIVE=0
systemctl is-active --quiet chinese-reader && WAS_ACTIVE=1
WAS_ENABLED=$(systemctl is-enabled chinese-reader 2>/dev/null || true)
rollback() {
  local result=$?
  trap - ERR
  set +e
  echo "Installation failed; restoring the previous service. Backup: $BACKUP" >&2
  systemctl stop chinese-reader
  if [[ -f "$BACKUP/chinese-reader.service" ]]; then
    cp -a "$BACKUP/chinese-reader.service" "$SERVICE"
  else
    systemctl stop chinese-reader
    rm -f "$SERVICE"
  fi
  if [[ -f "$BACKUP/server" ]]; then
    cp -a "$BACKUP/server" /opt/chinese-reader/server.rollback
    mv /opt/chinese-reader/server.rollback /opt/chinese-reader/server
  else
    rm -f /opt/chinese-reader/server
  fi
  rm -rf /etc/chinese-reader
  [[ ! -d "$BACKUP/config" ]] || cp -a "$BACKUP/config" /etc/chinese-reader
  systemctl daemon-reload
  case "$WAS_ENABLED" in
    enabled) ;;
    enabled-runtime) systemctl disable chinese-reader; systemctl enable --runtime chinese-reader ;;
    *) systemctl disable chinese-reader ;;
  esac
  if [[ $WAS_ACTIVE -eq 1 ]]; then systemctl restart chinese-reader; fi
  # ACL/account grants are retained for inspection; original ACLs are backed up.
  exit "$result"
}
trap rollback ERR

getent group "$ACCOUNT" >/dev/null || groupadd --system "$ACCOUNT"
id "$ACCOUNT" >/dev/null 2>&1 || useradd --system --gid "$ACCOUNT" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
[[ $(id -u "$ACCOUNT") -ne 0 && $(id -g "$ACCOUNT") -eq $(getent group "$ACCOUNT" | cut -d: -f3) ]] || {
  echo 'Existing service account has unexpected UID or primary group.' >&2; exit 1;
}
# Grant traversal only through private parent directories. Do not open up the home.
setfacl -m "u:$ACCOUNT:--x" /home/daniel /home/daniel/.local /home/daniel/.local/share
setfacl -m "u:$ACCOUNT:rwx" "$DB_DIR"
# Both the daemon and daniel's import/migration tools must retain WAL access.
setfacl -m "d:u:$ACCOUNT:rwx,d:u:daniel:rwx,d:o::---" "$DB_DIR"
setfacl -m "u:$ACCOUNT:rw-" "$DB"
for sidecar in "$DB-wal" "$DB-shm"; do
  [[ ! -f "$sidecar" ]] || setfacl -m "u:$ACCOUNT:rw-" "$sidecar"
done

install -d -o root -g root -m 755 /opt/chinese-reader
install -o root -g root -m 755 "$BINARY" /opt/chinese-reader/server.new
mv /opt/chinese-reader/server.new /opt/chinese-reader/server
install -d -o root -g "$ACCOUNT" -m 750 /etc/chinese-reader /etc/chinese-reader/tls
install -o root -g "$ACCOUNT" -m 640 "$ROOT/chasmfiend.local.pem" /etc/chinese-reader/tls/cert.pem
install -o root -g "$ACCOUNT" -m 640 "$ROOT/chasmfiend.local-key.pem" /etc/chinese-reader/tls/key.pem
printf 'CHINESE_READER_ALLOWED_ORIGINS=%s\n' "$ORIGINS" > /etc/chinese-reader/origins.env
chown root:"$ACCOUNT" /etc/chinese-reader/origins.env
chmod 640 /etc/chinese-reader/origins.env

install -d -m 700 "$BACKUP/candidate"
cat > "$BACKUP/candidate/chinese-reader.service" <<UNIT
[Unit]
Description=Chinese Reader HTTPS server
After=network.target

[Service]
User=$ACCOUNT
Group=$ACCOUNT
EnvironmentFile=/etc/chinese-reader/origins.env
ExecStart=/opt/chinese-reader/server --dist $ROOT/dist --cert /etc/chinese-reader/tls/cert.pem --key /etc/chinese-reader/tls/key.pem --db-path $DB
WorkingDirectory=$ROOT
Restart=on-failure
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DB_DIR
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0007

[Install]
WantedBy=multi-user.target
UNIT

# Validate permissions as the actual account before restarting production.
runuser -u "$ACCOUNT" -- test -r "$ROOT/dist/index.html"
runuser -u "$ACCOUNT" -- test -r /etc/chinese-reader/tls/key.pem
runuser -u "$ACCOUNT" -- test -w "$DB"
runuser -u "$ACCOUNT" -- test -w "$DB_DIR"
systemd-analyze verify "$BACKUP/candidate/chinese-reader.service"
install -o root -g root -m 644 "$BACKUP/candidate/chinese-reader.service" "$SERVICE"
systemctl daemon-reload
systemctl enable chinese-reader.service
systemctl restart chinese-reader.service
for attempt in {1..30}; do
  if systemctl is-active --quiet chinese-reader && curl -kfSs --max-time 2 https://127.0.0.1/health >/dev/null; then
    # A healthy old binary is insufficient: verify the actual API boundary.
    [[ $(curl -ksS --max-time 5 -o /dev/null -w '%{http_code}' \
      -H 'Origin: https://untrusted.invalid' https://127.0.0.1/api/texts/0) == 403 ]]
    for origin in "${origin_list[@]}"; do
      curl -kfSs --max-time 15 -o /dev/null -X POST \
        -H "Origin: $origin" -H 'Content-Type: application/json' -d '{}' \
        https://127.0.0.1/api/invoke/get_shelf_tree
    done
    echo "Installed non-root service. Rollback files: $BACKUP"
    systemctl --no-pager status chinese-reader.service
    exit 0
  fi
  sleep 1
done

echo "Health check failed. Restore the prior unit from $BACKUP/chinese-reader.service and, if present, $BACKUP/server and $BACKUP/config; then daemon-reload and restart." >&2
journalctl -u chinese-reader -n 30 --no-pager >&2
false
