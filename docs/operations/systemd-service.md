# Chinese Reader Systemd Service

This machine runs Chinese Reader as a local systemd daemon named
`chinese-reader`.

The service installed by `scripts/install-service.sh` serves the frontend from:

```text
/home/daniel/exper/chinese_reader_app/dist
```

and runs the server binary from:

```text
/home/daniel/exper/chinese_reader_app/src-tauri/target/release/server
```

## Check The Daemon

```bash
sudo systemctl status chinese-reader
sudo journalctl -u chinese-reader -f
```

The health endpoint should return `ok` from the host network:

```bash
curl -k https://localhost/health
```

The installed service passes `--cert` and `--key`, so the server uses its TLS
default port, `443`, unless `--port` is added to the service file. If TLS is not
enabled in the active service file, the server's default port is `3000`:

```bash
curl http://localhost:3000/health
```

## Deploy Frontend-Only Changes

For TypeScript, CSS, service-worker, or other browser-only changes:

```bash
npm run build
sudo systemctl restart chinese-reader
```

Then refresh the browser/PWA. If the installed PWA still shows old assets, use
the app's refresh button or fully reload the browser tab. The service worker is
network-first for the app shell, but installed PWAs can keep an older shell in
memory until the page is refreshed.

## Deploy Server Changes

For Rust backend changes:

```bash
npm run build
cd src-tauri
cargo build --release
cd ..
sudo systemctl restart chinese-reader
```

## Deploy Schema Changes

When a change includes database migrations, prefer the backup/migration helper:

```bash
scripts/backup-and-migrate-db.sh
```

That script builds the frontend and release binaries, backs up the database,
runs migrations, and restarts `chinese-reader`.

## Reinstall Or Update The Service File

If paths, certificates, database location, or service options change:

```bash
cd src-tauri && cargo build --release && cd ..
npm run build
sudo bash scripts/install-service.sh
```
