#!/usr/bin/env bash
set -euo pipefail

BINARY=/home/daniel/exper/chinese_reader_app/src-tauri/target/release/server
DIST=/home/daniel/exper/chinese_reader_app/dist
CERT=/home/daniel/exper/chinese_reader_app/chasmfiend.local.pem
KEY=/home/daniel/exper/chinese_reader_app/chasmfiend.local-key.pem
SERVICE=/etc/systemd/system/chinese-reader.service

cat > "$SERVICE" <<EOF
[Unit]
Description=Chinese Reader HTTP server
After=network.target

[Service]
ExecStart=$BINARY --dist $DIST --cert $CERT --key $KEY --db-path /home/daniel/.local/share/com.chinesereader.ChineseReader/dictionary.db
WorkingDirectory=/home/daniel/exper/chinese_reader_app
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable chinese-reader.service
systemctl restart chinese-reader.service
systemctl status chinese-reader.service
