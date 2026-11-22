# Server Security Implementation Plan

**Goal:** Reject cross-origin API access and remove root execution, retaining LAN access.
**Spec:** ../specs/2026-11-21-server-security-design.md
**Execution:** Inline, within the user's authorization to fix both reviewed issues.

- [x] Add failing HTTP regression tests for hostile/opaque/duplicate origins,
  cross-site metadata without Origin, JSON forms, trusted LAN/Tailscale origins,
  originless scripts, and preflights. Verify no handler side effects on rejection.
- [x] Implement request security middleware, remove permissive CORS, load explicit
  trusted origins with fail-closed configuration validation.
- [x] Prepare an installer that creates a dedicated account, grants narrowly
  scoped ACL access, installs a hardened unit, and retains rollback files.
- [x] Test Rust suites and validate the unit on Linux against staged remote
  sources. Preserve all unrelated local and remote changes.
- [x] Activate if sudo is available; otherwise stage the tested binary and installer
  and give the user the concrete sudo command. Verify live behavior after activation.

Review focus: proxy headers must not grant trust; JSON writes must remain usable
from both origins; rejected writes never reach handlers; SQLite WAL files retain
access across service restarts and user maintenance; the service keeps port 443.


## Verification and activation state

- Local Rust suite: 78 library tests plus 5 server tests passed.
- Remote snapshot suite: 78 library tests plus 5 server tests passed.
- Observed regression tests fail against the passthrough policy, then pass with
  the guard. The actual Linux release also passed a disposable-database smoke
  test covering blocked writes without mutation, both trusted origins, forms,
  preflights, originless requests, and a non-root high-port process.
- Linux `systemd-analyze verify` accepted a copy of the hardened unit with only
  the not-yet-installed /opt executable path changed to the staged executable.
  Actual dedicated-account/port-443/sandbox activation still requires sudo.
- Source fixes and documentation applied on chasmfiend using context patches;
  pre-existing remote files saved under `.security-staging/20261121/`.
- Linux release SHA-256:
  `5f0976b3c8d75cc88ea8f91ef002cac84f0cf9e80f3072786937c9dd3aa25dc3`.
- Skill-requested independent review found a rollback case for a previously
  inactive service. Fixed by always stopping the candidate and restoring its
  enabled state before restarting only a previously active service.
- Live service remains unchanged: interactive sudo authentication is unavailable
  to the agent. Run `bash .security-staging/20261121/activate.sh` on chasmfiend.
  The installer backs up the prior unit/config/binary, checks the real API guard
  and both configured origins, and rolls back if those checks fail. The wrapper
  checks the service user and both Tailscale address families after installation.
