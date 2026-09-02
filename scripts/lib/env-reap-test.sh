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
# It now also replays #3922, the other half of the same guard: a box with NO env rows was reaped
# on the unattended timer's first tick, because the registry reported "no data" as 999999 and this
# file compared it against a 90-minute threshold. Same shape of defect — a decision nobody could
# run — so it is proved the same way, through `env:reap` itself rather than through the function.
#
# Hermetic: no box, no ssh, no hcloud, no network. `env:reap --dry-run` reads the fixture registry
# named by ALETHIA_ENV_REGISTRY_FILE, derives idleness from scripts/box/env-registry.sh, and
# destroys nothing. The last cases assert that both overrides are confined to the dry run, so
# neither seam can weaken a real reap.
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
# 70 minutes: past the 60m ownership window, short of the 90m reap threshold. In that gap the
# IDLE gate is the only thing holding the box, which is where it has to be exercised.
mid_iso() { date -u -v-70M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '70 minutes ago' +%Y-%m-%dT%H:%M:%SZ; }

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

# ── 6. THE IDLE GATE. An absence is not an idle age (#3922). ────────────────────────────────────
# A box holding no env rows was reaped on the unattended timer's FIRST tick: the registry answered
# "no data" with 999999, and 999999 is not less than the 90m threshold. These cases run WITHOUT
# --now, because --now skips the threshold and every case above passes it.

f="$(fixture idle-empty '{}')"
reap "$f" "$$"
rc="$RC"
if [ "$rc" = 0 ] && has "no environment activity has ever been recorded" && has "would stop at the idle gate"; then
	ok "an EMPTY registry does not reap — no rows is not an idle age (#3922)"
else
	bad "an empty registry must not reap unattended (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi
if has "999999"; then bad "the empty case still reports the 999999 sentinel"; else
	ok "the empty case reports no sentinel quantity at all"
fi
if has "most recent activity was"; then
	bad "the empty case claims a 'most recent activity' the registry never recorded"
else
	ok "the empty case does not claim an activity time it never measured"
fi
if has 'idle report: none'; then ok "the idle report for an empty registry is a word, not a number"
else bad "an empty registry should report 'none'"; fi

# …and --now still retires an abandoned empty box. Refusing the timer must not cost the escape
# hatch: an unreaped box is EUR 69.49/mo against 0.72.
reap "$f" "$$" --now
rc="$RC"
if [ "$rc" = 0 ] && has "would snapshot and DELETE" && has "on your say-so, not on a measurement"; then
	ok "--now still reaps an empty box, and says it is acting on a say-so not a measurement"
else
	bad "--now must still reap an empty box (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# The MEASURED path is untouched: 70 minutes is past the 60m ownership window and short of the
# 90m threshold, so nothing blocks except idleness itself.
f="$(fixture idle-recent "{\"other-lane\":$(row "$THEM" "$(mid_iso)")}")"
reap "$f" "$$"
rc="$RC"
if [ "$rc" = 0 ] && has "most recent activity was 70m ago (threshold 90m)"; then
	ok "a measured idle age under the threshold still holds, and still says the number"
else
	bad "a 70m-idle box must hold on the threshold (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

f="$(fixture idle-old "{\"other-lane\":$(row "$THEM" "$(old_iso)")}")"
reap "$f" "$$"
rc="$RC"
if [ "$rc" = 0 ] && has "the idle gate does not stop it"; then
	ok "a genuinely idle box still reaps without --now — the gate is not a blanket refusal"
else
	bad "a 6h-idle box must pass the idle gate (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# An unparseable lastSeen is the OTHER absence, and it always failed safe. It must still fail
# safe, and it must say something different: "could not read the stamp" and "there was no stamp"
# are different facts about the box. --include-mine because a bad stamp sorts as live.
f="$(fixture idle-bad "{\"my-lane\":$(row "$ME" "not-a-date")}")"
reap "$f" "$$" --include-mine
rc="$RC"
if [ "$rc" = 0 ] && has "would stop at the idle gate" && has "timestamp could not be read" &&
	! has "most recent activity was"; then
	ok "an unreadable timestamp holds the reap and names the reason, without inventing a number"
else
	bad "an unreadable timestamp must hold the reap (rc=$rc)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# THE STALE BOX. scripts/box/ ships from the main checkout at provision time, so a box created
# before this fix keeps sending the old 999999 — the one report a fixture registry cannot
# produce, and the one that matters in the field until every box is reprovisioned.
RC=0
OUT="$(cd "$ROOT" && ALETHIA_ENV_REGISTRY_FILE="$(fixture idle-legacy '{}')" \
	ALETHIA_ENV_IDLE_REPORT=999999 CLAUDE_PID="$$" \
	bash "$ENV_SH" reap --dry-run 2>&1)" || RC=$?
if [ "$RC" = 0 ] && has "no environment activity has ever been recorded" && ! has "999999m ago"; then
	ok "a pre-#3922 box still reporting 999999 is read as an absence, not as 694 idle days"
else
	bad "the legacy 999999 sentinel must normalise to an absence (rc=$RC)"
	printf '%s\n' "$OUT" | sed 's/^/       /'
fi

# ── 7. The test seams cannot weaken a real reap. ────────────────────────────────────────────────
# Every mention of either override must sit ABOVE cmd_reap(), i.e. inside the dry-run path only.
real_start="$(grep -n '^cmd_reap() {' "$ENV_SH" | cut -d: -f1)"
for var in ALETHIA_ENV_REGISTRY_FILE ALETHIA_ENV_IDLE_REPORT; do
	stray="$(grep -n "$var" "$ENV_SH" | cut -d: -f1 | awk -v s="$real_start" '$1 > s')"
	if [ -n "$real_start" ] && [ -z "$stray" ]; then
		ok "$var is confined to the dry run — a real reap always reads the box"
	else
		bad "$var leaked into the real reap path (lines: ${stray:-none}, cmd_reap at ${real_start:-?})"
	fi
done

kill "$OTHER_PID" 2>/dev/null
if [ "$fails" = 0 ]; then
	echo "env-reap guard: all passed"
else
	echo "env-reap guard: $fails failed" >&2
fi
exit "$fails"
