# Chinese Reader Systemd Service

This machine runs Chinese Reader as a local systemd daemon named
`chinese-reader`.

The service installed by `scripts/install-service.sh` serves the frontend from:

```text
/home/daniel/exper/chinese_reader_app/dist
```

and runs the server binary from:

```text
/opt/chinese-reader/server
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
sudo bash scripts/install-service.sh
```

The installer copies the release binary into `/opt/chinese-reader/server`; a
restart alone does not install a newly built backend.

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


## Service Security

The installer runs the app as the dedicated `chinese-reader` account. It grants
traversal through private parent directories and read/write ACLs on the database
and SQLite WAL files. Default ACLs preserve access for both the daemon and
`daniel` when import tools or the server recreate those files. It copies TLS
files into `/etc/chinese-reader/tls` and the binary into `/opt/chinese-reader`.
The filesystem is read-only in the service except for the database directory
and a private temporary directory. Only `CAP_NET_BIND_SERVICE` is granted,
so the intentional LAN listener remains on port 443.

On the first install, pass both exact browser origins (replace the example
Tailscale hostname with the one from `tailscale serve status`):

```bash
sudo bash scripts/install-service.sh --origins 'https://chasmfiend.local,https://reader.your-tailnet.ts.net:9443'
```

Subsequent installs preserve `/etc/chinese-reader/origins.env`. Use `--origins`
to replace that list if a hostname or port changes. Values must be canonical
HTTP(S) origins without trailing slashes. The API rejects unapproved/opaque
Origin headers and cross-site Fetch Metadata. CORS is disabled; the frontend
uses same-origin requests. Command-line clients without Origin still work.
This is an origin/CSRF boundary, not user authentication: clients with direct
network access can still call the API.

Without the environment setting, standalone development accepts only
`http://localhost:3000` and `http://127.0.0.1:3000` as browser origins. Configure
`CHINESE_READER_ALLOWED_ORIGINS` for other development URLs.

Installer dependencies include `setfacl`/`getfacl` (the Linux `acl` package).
The installer validates permissions, the unit, and startup health; on failure it
restores the previous unit, binary, and configuration. Backups are retained
under `/var/backups/chinese-reader-security/`. Account/ACL grants remain after a
failed install, with original ACLs saved there for inspection.

After installation verify `systemctl show chinese-reader -p User -p
NoNewPrivileges` and confirm health through both the LAN and Tailscale URLs.
The running User must be `chinese-reader`. Certificate renewals for the LAN
certificate require reinstalling the copied certificate with this installer;
Tailscale continues managing its own browser-facing certificate independently.
