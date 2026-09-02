#!/usr/bin/env bash
# shellcheck shell=bash
#
# Replays incident #3841 against the REAL `scripts/env.sh` code path.
#
# scripts/lib/env-owner.sh --self-test proves the decision function. This proves the thing that
# actually failed: that `pnpm env:reap --now`, run the way a finished lane runs it, is refused when
# another instance's environment is live. The guard existed and was correct-looking for weeks while
# being unreachable, so "the function returns refuse-others" is not the claim that matters — "the
# command refuses" is.
#
# Hermetic: no box, no ssh, no hcloud, no network. `env:reap --dry-run` reads the fixture registry
# named by ALETHIA_ENV_REGISTRY_FILE and destroys nothing. The last case asserts that the override
# is confined to the dry run, so this seam can never weaken a real reap.
#
#   bash scripts/lib/env-reap-test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_SH="$ROOT/scripts/env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fails=0
ok() { echo "ok   - $1"; }
bad() {
	echo "FAIL - $1" >&2
	fails=$((fails + 1))
}

# A second live process on this host, so "another instance" is a real one and not a string.
sleep 120 &
OTHER_PID=$!
trap 'kill "$OTHER_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# shellcheck source=scripts/lib/env-owner.sh
. "$HERE/env-owner.sh"
ME="$(CLAUDE_PID="$$" env_owner)"
THEM="$(CLAUDE_PID="$OTHER_PID" env_owner)"
LEGACY="$(id -un)@$(wt_host)" # what every instance wrote before this fix

[ "$ME" != "$THEM" ] ||
	bad "two live instances on this host still share one owner string — the fix is inert"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
old_iso() { date -u -v-6H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ; }

fixture() { # <name> <json> → path
	printf '%s' "$2" >"$TMP/$1.json"
	printf '%s' "$TMP/$1.json"
}

row() { # <owner> <lastSeen>
	printf '{"consolePort":3200,"storagePort":8342,"database":"alethia_x","owner":"%s","lastSeen":"%s"}' "$1" "$2"
}

# Runs env:reap the way a lane does, against a fixture registry. Leaves the exit code in $RC and
# the combined output in $OUT — combined, and in order, because "what am I about to destroy" being
# printed BEFORE the verdict is half of what was asked for.
#
# NOT `rc="$(reap …)"`: a command substitution is a SUBSHELL, so every variable this sets would be
# discarded and every text assertion below would silently match an empty string. The first draft of
# this file did exactly that and reported ten failures with no output to show.
OUT=""
RC=0
reap() { # <fixture-path> <claude-pid|""> <flags…>
	local f="$1" pid="$2"
	shift 2
	RC=0
	OUT="$(cd "$ROOT" && ALETHIA_ENV_REGISTRY_FILE="$f" CLAUDE_PID="$pid" \
		bash "$ENV_SH" reap --dry-run "$@" 2>&1)" || RC=$?
}

has() { printf '%s' "$OUT" | grep -q "$1"; }

# ── 1. THE INCIDENT. Another instance's env, touched seconds ago; I am finished and reap. ───────
f="$(fixture others-live "{\"other-lane\":$(row "$THEM" "$(now_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 3 ] && has "Not reaping — someone else is working on this box" && has "other-lane"; then
	ok "another instance's LIVE env refuses env:reap --now, and names it"
else
	bad "another instance's LIVE env must refuse env:reap --now (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# The manifest comes FIRST — before the refusal, and before anything is destroyed.
if [ "$(printf '%s\n' "$OUT" | grep -n 'reaping deletes the box' | cut -d: -f1)" -lt \
	"$(printf '%s\n' "$OUT" | grep -n 'Not reaping' | cut -d: -f1)" ]; then
	ok "what will be destroyed is printed BEFORE the verdict"
else
	bad "the destroy manifest must precede the verdict"
fi
if has "last seen"; then ok "the manifest carries each env's last-seen time"; else bad "manifest has no last-seen"; fi

# ── 2. …and it ALLOWS when nothing else is live. A guard never seen to pass is not a guard. ─────
f="$(fixture others-idle "{\"other-lane\":$(row "$THEM" "$(old_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 0 ] && has "nobody is blocking"; then
	ok "an idle foreign env does not block — the reap proceeds"
else
	bad "an idle foreign env must not block (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

f="$(fixture empty '{}')"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 0 ] && has "no environments are registered"; then
	ok "an empty registry reaps, and says the box is empty"
else bad "empty registry must reap (rc=$rc)"; fi

# ── 3. THE LEGACY PATH. A pre-#3841 `user@host` row is not silently mine. ───────────────────────
f="$(fixture legacy "{\"old-lane\":$(row "$LEGACY" "$(now_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 3 ] && has "legacy user@host owner" && has "counted as someone else's"; then
	ok "a legacy user@host owner is refused as someone else's, and says why"
else
	bad "a legacy owner must not be treated as mine (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# The contrast that shows the OLD behaviour: with no agent pid the identity IS `user@host`, the
# row reads as mine, and only the new my-own-envs gate stops it. That is precisely how every
# instance saw every environment before this change.
reap "$f" "" --now
rc="$RC"
if [ "$rc" = 4 ] && has "your own environment is still live"; then
	ok "the same row IS mine to a bare user@host caller (the old scheme, now gated)"
else bad "a bare-identity caller should classify a bare-owner row as mine (rc=$rc)"; fi

# ── 4. MY OWN live env stops --now until I say otherwise. ───────────────────────────────────────
f="$(fixture mine "{\"my-lane\":$(row "$ME" "$(now_iso)")}")"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 4 ] && has "your own environment is still live" && has "pnpm env:down"; then
	ok "my own live env refuses --now and points at env:down"
else
	bad "my own live env must refuse --now (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

reap "$f" "$$" --now --include-mine
rc="$RC"
if [ "$rc" = 0 ]; then ok "--include-mine is the explicit way to say I meant both"
else bad "--include-mine must allow my own live env (rc=$rc)"; fi

# …but it is not a general override.
f="$(fixture mine-and-theirs "{\"my-lane\":$(row "$ME" "$(now_iso)"),\"other-lane\":$(row "$THEM" "$(now_iso)")}")"
reap "$f" "$$" --now --include-mine
rc="$RC"
if [ "$rc" = 3 ]; then ok "--include-mine still refuses when someone ELSE is live"
else bad "--include-mine must not unlock a foreign live env (rc=$rc)"; fi

# ── 5. Fail CLOSED, and refuse what it does not understand. ─────────────────────────────────────
f="$(fixture broken 'this is not json')"
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 1 ] && has "did not parse"; then ok "an unparseable registry refuses (fails closed)"
else bad "an unparseable registry must refuse (rc=$rc)"; fi

reap "$(fixture empty2 '{}')" "$$" --now --harder
rc="$RC"
if [ "$rc" = 1 ] && has "unknown flag"; then ok "an unknown flag is refused, never ignored"
else bad "unknown flags must be refused (rc=$rc)"; fi

# ── 6. The test seam cannot weaken a real reap. ─────────────────────────────────────────────────
# Every mention of the override must sit ABOVE cmd_reap(), i.e. inside the dry-run path only.
real_start="$(grep -n '^cmd_reap() {' "$ENV_SH" | cut -d: -f1)"
stray="$(grep -n 'ALETHIA_ENV_REGISTRY_FILE' "$ENV_SH" | cut -d: -f1 | awk -v s="$real_start" '$1 > s')"
if [ -n "$real_start" ] && [ -z "$stray" ]; then
	ok "ALETHIA_ENV_REGISTRY_FILE is confined to the dry run — a real reap always reads the box"
else
	bad "ALETHIA_ENV_REGISTRY_FILE leaked into the real reap path (lines: ${stray:-none}, cmd_reap at ${real_start:-?})"
fi

kill "$OTHER_PID" 2>/dev/null
if [ "$fails" = 0 ]; then
	echo "env-reap guard: all passed"
else
	echo "env-reap guard: $fails failed" >&2
fi
exit "$fails"
