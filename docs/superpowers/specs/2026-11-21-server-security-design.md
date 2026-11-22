# Server request and service security

Fix the two security issues identified in the live review while retaining the
intentional LAN listener on port 443 and Tailscale Serve on 9443.

Approach: remove CORS (the frontend uses same-origin fetch), reject API requests
with unapproved Origin headers and cross-site Fetch Metadata, and retain
originless command-line access. Use an explicit origin list from
CHINESE_READER_ALLOWED_ORIGINS, including both live HTTPS URLs. Do not infer
trust from Host or forwarded headers. JSON-only POST handlers prevent HTML form
requests from bypassing the Origin check. Reject opaque and duplicate origins.

Run systemd as a dedicated chinese-reader account with narrowly granted ACLs,
CAP_NET_BIND_SERVICE for port 443, a read-only filesystem except for the database
directory, and no new privileges. Preserve the database location for importers.
Removing LAN access or adding a login system is outside this authorized fix.

Alternatives: an origin comparison against Host trusts attacker-controlled host
names; CORS removal alone does not reject writes; running as daniel removes root
but retains access to unrelated personal files. The dedicated account gives a
smaller permission boundary without relocating existing data.

Stage against the remote source snapshot rather than replacing it with the
diverged local checkout. Test request rejection and allowed requests before
activation. Back up binary and unit before activation. Sudo needs interactive
authentication; prepare a reviewable activation command if unavailable.
