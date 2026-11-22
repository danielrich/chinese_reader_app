# Chinese Reader over Tailscale

This setup provides private access from devices on the tailnet, trusted HTTPS,
and Android PWA installation.

## Example Configuration

These examples use reader.your-tailnet.ts.net and reader.local as placeholders.
Replace them with your server's actual Tailscale DNS name and LAN hostname.
The full Tailscale hostname is shown by `tailscale status --json` in the server's
`Self.DNSName` field (omit its trailing dot in URLs), and by Serve status after setup.

- Backend: the existing chinese-reader systemd service on HTTPS port 443
- LAN address: https://reader.local/ with its existing mkcert certificate
- Tailscale address: <https://reader.your-tailnet.ts.net:9443/>
- Serve target: https+insecure://127.0.0.1:443
- Browser-facing certificate: Let's Encrypt, managed by Tailscale Serve

```text
Client connected to Tailscale
  -> https://reader.your-tailnet.ts.net:9443
  -> Tailscale Serve terminates HTTPS with its Let's Encrypt certificate
  -> https://127.0.0.1:443
  -> existing Chinese Reader backend and SQLite database
```

The https+insecure scheme skips certificate validation only for the local proxy
connection. The backend certificate names reader.local, which does not match
127.0.0.1. The browser-facing connection still validates the Tailscale hostname.

## Setup

1. Install and sign in to Tailscale on the server and client devices. Tailnet
   access policies must allow the client to reach the server.
2. Enable MagicDNS and HTTPS certificates for the tailnet. If Serve needs
   enabling, the command below prints a Tailscale account URL to follow.
3. Check that the existing backend is running:

   ```bash
   sudo systemctl status chinese-reader
   curl -k https://127.0.0.1/health
   ```

   The response should be `ok`. Here -k is only for checking the local backend
   certificate; use normal validation for the Tailscale URL.

4. On the server, configure the private HTTPS proxy:

   ```bash
   sudo tailscale serve --bg --https=9443 https+insecure://127.0.0.1:443
   tailscale serve status
   ```

Expected status:

```text
https://reader.your-tailnet.ts.net:9443 (tailnet only)
|-- / proxy https+insecure://127.0.0.1:443
```

The --bg option persists the configuration across Tailscale restarts and reboots.
Serve obtains and renews the HTTPS certificate. Funnel is not needed for this
private tailnet setup. For another server, use its full hostname from Serve status.

If an earlier attempt configured this reader on Tailscale port 443, remove that
Serve entry after adding 9443:

```bash
sudo tailscale serve --https=443 off
```

This removes the Tailscale mapping; it does not stop the LAN reader service.
See [systemd service operations](systemd-service.md) for backend setup.

## Reboot Persistence

Both chinese-reader.service and tailscaled.service must be enabled at boot.
The reader continues running as its existing systemd daemon. Tailscale runs
separately, restores the saved --bg Serve configuration, and manages certificate
renewal. No extra proxy process or manual startup command is needed.

Check boot enablement and current state:

```bash
systemctl is-enabled chinese-reader.service tailscaled.service
systemctl is-active chinese-reader.service tailscaled.service
tailscale serve status
```

If either service is disabled:

```bash
sudo systemctl enable --now chinese-reader.service tailscaled.service
```

After reboot, rerun the health checks below. Access resumes once the backend
and Tailscale are running and the server has network connectivity. The client
device must also be connected to Tailscale.

## Why Port 9443 Matters

The Rust server currently listens on 0.0.0.0:443, covering every IPv4 interface,
including the Tailscale IPv4 address. Serve cannot bind the same IPv4 port.
Its daemon logs report:

```text
localListener failed to listen on <server-tailscale-ip>:443
bind: address already in use
```

Serve can still bind IPv6 in that situation. An IPv6 test may therefore pass
while IPv4 clients receive the backend's reader.local certificate. Port 9443
lets Serve listen on both address families while the original LAN URL keeps working.

Include **:9443** in the Tailscale URL. Omitting it connects to the original
backend on port 443 and can produce a certificate-name mismatch.

## Verify Both Address Families

Check IPv4 with certificate validation enabled:

```bash
curl -4 https://reader.your-tailnet.ts.net:9443/health
```

On the server, check its Tailscale IPv6 address explicitly, even if DNS only
returns an IPv4 address:

```bash
reader_ipv6=$(tailscale ip -6)
curl --resolve "reader.your-tailnet.ts.net:9443:[$reader_ipv6]" \
  https://reader.your-tailnet.ts.net:9443/health
```

Both should return `ok` without -k. Inspect listeners and logs if either fails:

```bash
ss -ltn
sudo journalctl -u tailscaled --since '10 minutes ago' --no-pager
```

The PWA resources should also return HTTP 200:

```bash
curl -I https://reader.your-tailnet.ts.net:9443/manifest.webmanifest
curl -I https://reader.your-tailnet.ts.net:9443/icon-192.png
curl -I https://reader.your-tailnet.ts.net:9443/icon-512.png
curl -I https://reader.your-tailnet.ts.net:9443/sw.js
```

The manifest should have a JSON content type, the icons image/png, and the
service worker a JavaScript content type.

## Install on Android

1. Connect the phone to Tailscale.
2. Open <https://reader.your-tailnet.ts.net:9443/> in Chrome.
3. Confirm the connection is secure, then use **Install app** or
   **Add to Home screen → Install**; wording varies by Chrome version.
4. Launch the new icon and confirm the reader loads.

An existing LAN install still points to its original LAN hostname. Installing
from the Tailscale URL creates an app for that origin. Both URLs use the same server database, but
browser caches and pending offline work belong to their respective origins.
Let the old app sync pending work before removing it; download desired offline
texts again in the new install.

### Chrome Still Shows Insecure

Confirm the full hostname and :9443 in the address bar. The certificate should
name reader.your-tailnet.ts.net and be issued by Let's Encrypt.

If the server checks pass, try the URL in a new Chrome Incognito tab to help
isolate saved browser state. If that connection is secure, force-stop Chrome
through Android **Settings → Apps → Chrome → Force stop**, then reopen the URL
in a normal tab and install there. Force-stopping preserves browser data.

If the warning persists in Incognito, inspect the security details and certificate
dates, check the phone's date/time, and record any NET::ERR_CERT_* error. Use
those details to diagnose the cause before changing the server configuration.

## Disable Tailscale Access

```bash
sudo tailscale serve --https=9443 off
```

The existing LAN service continues running.

## References

- [Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Enable Tailscale HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates)
- [Chrome connection troubleshooting on Android](https://support.google.com/chrome/answer/6098869?co=GENIE.Platform%3DAndroid&hl=en)
