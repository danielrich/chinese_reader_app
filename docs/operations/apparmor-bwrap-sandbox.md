# AppArmor And Bubblewrap Sandbox Notes

This note captures the local sandbox issue seen while running Codex commands on
Ubuntu/AppArmor with `bubblewrap`.

## Symptom

Sandboxed commands failed before the requested command ran:

```text
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

Later, while iterating on AppArmor rules, failures moved through:

```text
bwrap: setting up uid map: Permission denied
bwrap: setting up uid map: Operation not permitted
bwrap: Failed to make / slave: Permission denied
bwrap: pivot_root: Permission denied
bwrap: can't open /: Permission denied
```

The important clue from `journalctl -k` was:

```text
operation="userns_create" profile="unconfined" comm="bwrap" target="unprivileged_userns"
```

That means AppArmor's unprivileged user namespace mediation was moving the
process into the generic `unprivileged_userns` profile after user namespace
creation. A separate `bwrap-userns-restrict` profile did not fully solve the
issue because the failing operations happened after that transition.

## Files Involved

- `/etc/apparmor.d/bwrap-userns-restrict`
- `/etc/apparmor.d/unprivileged_userns`
- `/etc/apparmor.d/local/unprivileged_userns`
- `/usr/lib/sysctl.d/10-apparmor.conf`
- `/usr/lib/sysctl.d/50-bubblewrap.conf`

The useful host-side diagnostics were:

```bash
sudo journalctl -k --since "2 minutes ago" --no-pager | grep -Ei 'apparmor|DENIED|AUDIT|bwrap|uid_map|gid_map|capability|mount|pivot'
aa-status | grep bwrap
sysctl kernel.unprivileged_userns_clone
sysctl kernel.apparmor_restrict_unprivileged_userns
sysctl kernel.unprivileged_userns_apparmor_policy
```

## What Made It Work

The working direction was to keep `/usr/bin/bwrap` attached to a named profile
and add the specific permissions that audit logs showed were missing after the
transition into `unprivileged_userns`.

The `bwrap` profile needed an executable attachment:

```apparmor
profile bwrap-userns-restrict /usr/bin/bwrap flags=(attach_disconnected) {
    userns,

    capability setuid,
    capability setgid,
    capability setpcap,
    capability net_admin,

    network,
    network netlink raw,
    network netlink dgram,

    /usr/bin/bwrap rix,
    /** mr,
}
```

The generic `unprivileged_userns` profile needed to permit the operations that
`bwrap` performs inside its new namespace: UID map writes, loopback setup, mount
namespace setup, `pivot_root`, and opening `/` as a directory handle.

## Security Questions Before Tightening

- Can Codex's launcher avoid requesting a network namespace? If yes, the
  loopback and `net_admin` permissions could be avoided.
- Can the AppArmor transition target be made command-specific for `/usr/bin/bwrap`
  instead of broadening generic `unprivileged_userns`?
- Are `capability sys_admin` and `capability dac_override` acceptable inside
  the generic unprivileged-userns profile on this machine? They are broad, even
  inside a user namespace.
- Can mount rules be narrowed from generic `mount, umount, pivot_root` to the
  exact mount flags and paths reported by audit logs?
- Should these changes live in `/etc/apparmor.d/local/unprivileged_userns` where
  possible, with only unavoidable header changes in the main profile?
- Should this machine keep `kernel.apparmor_restrict_unprivileged_userns = 1`
  and carry local profile exceptions, or disable that mediation for local dev?

The pragmatic local result is that sandboxed file reads and writes work again.
The next hardening pass should start from the audit log and remove any broad
permissions that are not exercised by the actual Codex/bwrap command path.
