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

## Nightly Shelf-Analysis Maintenance

Shelf analysis is deferred work and is not computed by an interactive request.
Changes to texts, shelves, reading history, vocabulary, or segmentation mark the
affected shelf jobs dirty in SQLite. The daemon checks them every day at **00:05
in the server's local timezone**. On startup it also immediately processes work
due at the most recent 00:05 cutoff, so a daemon that was offline overnight
catches up without operator intervention. Changes made after the fixed cutoff
remain dirty for the following run.

The durable state is stored in two additive tables:

- `analysis_maintenance` contains the singleton `shelf_analysis` task, the
  earliest dirty time, run timestamps, and the last task-level error.
- `analysis_shelf_jobs` contains one row per requested or cached shelf, including
  dirty/request/completion timestamps and the last shelf-level error.

Inspect state without changing it:

```bash
DB=/home/daniel/.local/share/com.chinesereader.ChineseReader/dictionary.db
sqlite3 "$DB" \
  "SELECT task,dirty_at,last_started_at,last_completed_at,last_error FROM analysis_maintenance;"
sqlite3 -header -column "$DB" \
  "SELECT shelf_id,dirty_at,requested_at,last_completed_at,last_error FROM analysis_shelf_jobs ORDER BY COALESCE(dirty_at,requested_at);"
```

Run all work due as of the current time explicitly. This opens its own database
connection and exits after printing a JSON report; it does not start an HTTP
server:

```bash
/home/daniel/exper/chinese_reader_app/src-tauri/target/release/server \
  --db-path "$DB" --run-analysis-maintenance
```

Normal journal output includes one summary line beginning
`analysis_maintenance cutoff=` and, for every claimed shelf, a line beginning
`analysis_maintenance_job cutoff=`. Summary fields include duration, claimed,
succeeded, failed, final dirty state, and fatal error. Per-shelf lines include
shelf ID, duration, output size, and success. Inspect recent runs with:

```bash
sudo journalctl -u chinese-reader --since "2 days ago" --no-pager \
  | grep analysis_maintenance
```

Analysis computation is sequential on a dedicated SQLite connection. It does
not hold the HTTP server's global write semaphore; only each short cache
publication transaction competes with ordinary database writes.

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

For this release, retain both the SQLite online backup and the previous binary
and `dist` directory until Linux health checks and Android acceptance tests pass.
The new maintenance tables and lookup index are additive, so code rollback does
not require removing them. Given a deployment backup containing `server` and
`dist`, use the following procedure (set `CR_ROLLBACK` to its exact path):

```bash
CR_APP=/home/daniel/exper/chinese_reader_app
CR_ROLLBACK=/home/daniel/backups/chinese-reader/DEPLOYMENT_TIMESTAMP
CR_FAILED=/home/daniel/backups/chinese-reader/failed-deployment

mkdir -p "$CR_FAILED"
cp "$CR_ROLLBACK/server" "$CR_APP/src-tauri/target/release/server.rollback"
cp -a "$CR_ROLLBACK/dist" "$CR_APP/dist.rollback"
sudo systemctl stop chinese-reader
mv "$CR_APP/src-tauri/target/release/server" "$CR_FAILED/server"
mv "$CR_APP/src-tauri/target/release/server.rollback" "$CR_APP/src-tauri/target/release/server"
mv "$CR_APP/dist" "$CR_FAILED/dist"
mv "$CR_APP/dist.rollback" "$CR_APP/dist"
sudo systemctl start chinese-reader
curl -k https://localhost/health
systemctl show chinese-reader -p MainPID -p ActiveEnterTimestamp --no-pager
```

Restore the database backup only if data/schema rollback is actually required;
first stop the daemon, run `PRAGMA integrity_check` against the backup, and
preserve the failed database for investigation rather than overwriting it.

## Performance Measurements

Use repeated requests and record median/tail observations both before and after
deployment. Keep IDs and request bodies in shell variables and do not put
credentials in scripts or documentation:

```bash
BASE=https://127.0.0.1
time_invoke () {
  command_name="$1"
  request_body="$2"
  curl -ksS -o /dev/null -w "$command_name %{http_code} %{time_total}s\\n" \
    -H 'Content-Type: application/json' \
    --data "$request_body" "$BASE/api/invoke/$command_name"
}

time_invoke dictionary_lookup '{"query":"中文","include_examples":true,"include_character_info":true,"include_user_dictionaries":true,"sources":[]}'
time_invoke dictionary_lookup '{"query":"zhongwen","include_examples":true,"include_character_info":true,"include_user_dictionaries":true,"sources":[]}'
time_invoke get_shelf_tree '{}'
time_invoke get_text_reading_history '{"text_id":TEXT_ID}'
time_invoke get_shelf_analysis '{"shelf_id":SHELF_ID}'

curl -ksS -o /dev/null -w 'text %{http_code} %{size_download}B %{time_total}s\\n' \
  "$BASE/api/texts/TEXT_ID"
curl -ksS --compressed -D /tmp/vocab-headers.txt -o /dev/null \
  -w 'vocab %{http_code} %{size_download}B %{time_total}s\\n' \
  "$BASE/api/texts/TEXT_ID/vocab-cache"
grep -iE '^(content-encoding|etag):' /tmp/vocab-headers.txt
```

Run the same commands from a client by setting `BASE` to the server URL. Browser
network inspection should show no shelf-analysis request during normal shelf or
text navigation and no vocabulary-cache request when merely opening a text;
both are now explicit/lazy operations.

## Reinstall Or Update The Service File

If paths, certificates, database location, or service options change:

```bash
cd src-tauri && cargo build --release && cd ..
npm run build
sudo bash scripts/install-service.sh
```
