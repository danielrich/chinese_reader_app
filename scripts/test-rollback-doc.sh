#!/usr/bin/env bash
set -Eeuo pipefail

readonly DOC=${1:-docs/operations/systemd-service.md}
readonly SNIPPET="$(mktemp)"
trap 'rm -f -- "$SNIPPET"' EXIT

awk '/^sudo bash -s -- .*<<.ROLLBACK./ { capture=1; next } capture && /^ROLLBACK$/ { exit } capture { print }' "$DOC" > "$SNIPPET"
test -s "$SNIPPET"
bash -n "$SNIPPET"

# Command substitution in a readonly declaration masks failure. Guard the
# documented split assignment with an executable forced-failure regression.
if bash -Eeuo pipefail -c '
  touched=0
  mktemp() { return 73; }
  install() { touched=1; }
  CR_APP=/tmp/chinese-reader-rollback-test
  CR_STAGE="$(mktemp -d "$CR_APP/.rollback-stage.XXXXXX")"
  test -n "$CR_STAGE"
  install source "$CR_STAGE/server"
'; then
  echo "forced mktemp failure unexpectedly succeeded" >&2
  exit 1
fi

grep -q '^CR_STAGE="$(mktemp ' "$SNIPPET"
! grep -q '^readonly CR_STAGE="$(mktemp ' "$SNIPPET"
echo "rollback documentation syntax and mktemp failure handling passed"
