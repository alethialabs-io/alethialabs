#!/usr/bin/env bash
# shellcheck shell=bash
#
# Proves the suite-reap trap that #4343 added to `env:check` and `env:test`.
#
# WHY IT IS NOT ENOUGH THAT scripts/env.sh PARSES. The defect being fixed is that a remote suite
# outlives the shell that started it; the fix is three traps, an exit-code contract and a matcher
# that decides what dies on a box shared with every other instance. `bash -n` in ci.yml parses all
# of that and calls none of it — the same argument the box-script self-test step makes two hundred
# lines further down that file.
#
# WHAT IS DRIVEN. scripts/lib/env-suite-reap.sh's real functions, with `ssh_box` stubbed, so every
# assertion here is about the shipped text and not about a copy of it. Hermetic: no box, no ssh, no
# network. The remote script is exercised against a FIXTURE /proc, built the way /proc/<pid>/environ
# actually is (NUL-separated, no trailing newline), with `kill` and `pgrep` stubbed.
#
# THE SHAPE OF THE SIGNAL CASES IS THE POINT. An earlier private harness stood a backgrounded
# `sleep` plus `wait` in for the ssh, and `wait` is a special case: bash TERMINATES on an unhandled
# INT while in `wait`, so removing the INT trap left that harness green and the PR shipped with a
# comment claiming the EXIT trap alone covered it. In the real cmd_check shape — a FOREGROUND child
# and a signal delivered to the SCRIPT ALONE — bash abandons the wait and CONTINUES to suite_disarm,
# so no reap fires and an interrupted check returns 0. Section 1 runs both deliveries, to the
# process alone and to the group, and section 4 requires the INT-only mutation to be caught.
#
#   bash scripts/lib/env-suite-reap-test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_SH="$ROOT/scripts/env.sh"
LIB="$HERE/env-suite-reap.sh"
# Absolute: this file re-invokes itself for the child and the mutation probes, and a relative
# ${BASH_SOURCE[0]} would only resolve for one working directory.
SELF="$HERE/env-suite-reap-test.sh"
SLEEP="$(command -v sleep)"

# ── mode: one armed run, in the shape cmd_check uses ──────────────────────────────────────────
# $2 lib · $3 log · $4 ready-file · $5 case
if [ "${1:-}" = "--child" ]; then
	set -euo pipefail
	# shellcheck disable=SC2034  # read by suite_reap, which is sourced below — env.sh's own value.
	REMOTE=/opt/alethia
	LOG="$3"
	READY="$4"
	# Every remote invocation recorded as ONE line: the reap command is a multi-line script, and a
	# per-line record lets an assertion match a line INSIDE it and believe it read the whole thing.
	ssh_box() { printf 'SSH<<%s>>\n' "$(printf '%s' "$*" | tr '\n' ' ')" >>"$LOG"; }
	# shellcheck source=/dev/null
	. "$2"
	rc=0
	case "$5" in
	ok)
		suite_arm s1
		ssh_box "fake suite --pass" || rc=$?
		suite_disarm
		exit "$rc"
		;;
	red)
		suite_arm s1
		{ ssh_box "fake suite --fail"; false; } || rc=$?
		suite_disarm
		exit "$rc"
		;;
	exit7)
		suite_arm s1
		exit 7
		;;
	hang)
		suite_arm s1
		: >"$READY"
		# FOREGROUND, and `|| rc=$?` exactly as cmd_check writes it. Not `cmd &; wait` — see the
		# header: that shape hides the defect this case exists to catch.
		"$SLEEP" 2 || rc=$?
		suite_disarm
		exit "$rc"
		;;
	esac
	exit 0
fi

fails=0
ok() { echo "ok   - $1"; }
bad() {
	echo "FAIL - $1" >&2
	fails=$((fails + 1))
}

# ── mode: every mechanical assertion, against ONE lib (the real one, or a mutant) ─────────────
if [ "${1:-}" = "--probe" ]; then
	lib="$2"
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	# Job control: a background job started by a NON-interactive shell inherits SIGINT ignored, and
	# a trap cannot take back a signal inherited ignored. Without this the INT cases report "the
	# trap never fired" about a trap that was never given the chance — a false RED.
	set -m

	# `|| true`, NOT `|| echo 0`: grep -c already PRINTS 0 when it matches nothing and exits 1, so
	# the echo appends a second line and every "= 0" comparison below fails against "0\n0".
	reaps() { grep -c "^SSH<<.*ALETHIA_SUITE_TAG=" "$1" 2>/dev/null || true; }
	child() { bash "$SELF" --child "$lib" "$2" "$TMP/ready" "$1" >/dev/null 2>&1; }

	# 1. A run that ENDS reaps nothing: green, red, and the exit code survives the trap.
	: >"$TMP/ok.log"
	rc=0
	child ok "$TMP/ok.log" || rc=$?
	[ "$rc" = 0 ] || bad "a passing run should exit 0, got $rc"
	[ "$(reaps "$TMP/ok.log")" = 0 ] || bad "a passing run reaped — it has nothing left to stop"
	grep -q 'fake suite --pass' "$TMP/ok.log" || bad "the suite never ran"

	: >"$TMP/red.log"
	rc=0
	child red "$TMP/red.log" || rc=$?
	[ "$rc" = 1 ] || bad "a red run should carry its own exit code out, got $rc"
	[ "$(reaps "$TMP/red.log")" = 0 ] || bad "a red run reaped — it finished on the box already"

	# 2. An exit while ARMED reaps, exactly once, and the cleanup does not speak for the run.
	: >"$TMP/e7.log"
	rc=0
	child exit7 "$TMP/e7.log" || rc=$?
	[ "$rc" = 7 ] || bad "the reap rewrote the run's exit code (want 7, got $rc)"
	[ "$(reaps "$TMP/e7.log")" = 1 ] || bad "an armed exit should reap exactly once"

	# 3. Signals. Both deliveries, because they take different paths through bash.
	for delivery in alone group; do
		for sig in INT TERM; do
			log="$TMP/$sig-$delivery.log"
			: >"$log"
			rm -f "$TMP/ready"
			bash "$SELF" --child "$lib" "$log" "$TMP/ready" hang >/dev/null 2>&1 &
			kid=$!
			for _ in $(seq 1 200); do
				[ -e "$TMP/ready" ] && break
				"$SLEEP" 0.05
			done
			[ -e "$TMP/ready" ] || bad "$sig/$delivery: the child never armed"
			case "$delivery" in
			alone) kill -"$sig" "$kid" 2>/dev/null || true ;;
			group) kill -"$sig" -"$kid" 2>/dev/null || true ;;
			esac
			wait "$kid"
			rc=$?
			case "$sig" in
			INT) want=130 ;;
			TERM) want=143 ;;
			esac
			[ "$rc" = "$want" ] || bad "$sig/$delivery: exit code $rc, want $want"
			[ "$(reaps "$log")" = 1 ] || bad "$sig/$delivery: reaped $(reaps "$log") times, want 1"
		done
	done

	# 3b. DYING of the signal is not the same as exiting 130, and bash's `wait` cannot tell them
	#     apart — both report 130. The handler ends in `trap - INT; kill -INT $$` for that reason,
	#     and it was DEAD until the reap call gained `|| true`: suite_reap returns the status it
	#     was entered with (130 on a group Ctrl-C) and `set -e` aborted the handler right there.
	#     Measured here through a waiter that can see WIFSIGNALED. Without python3 the property is
	#     unmeasurable rather than true, so say so instead of passing.
	if command -v python3 >/dev/null 2>&1; then
		rm -f "$TMP/ready"
		: >"$TMP/sig.log"
		code="$(python3 - "$lib" "$SELF" "$TMP/sig.log" "$TMP/ready" <<'PY'
import os, signal, subprocess, sys, time
lib, driver, log, ready = sys.argv[1:5]
p = subprocess.Popen(["bash", driver, "--child", lib, log, ready, "hang"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
for _ in range(200):
    if os.path.exists(ready):
        break
    time.sleep(0.05)
os.killpg(p.pid, signal.SIGINT)      # what a terminal Ctrl-C does
p.wait()
print(p.returncode)                  # negative => killed by that signal
PY
		)"
		if [ "$code" = "-2" ]; then
			ok "a group Ctrl-C kills the shell with SIGINT rather than exiting 130 by errexit"
		else
			bad "a group Ctrl-C left the shell exiting $code — the re-raise is dead code"
		fi
	else
		echo "skip - signal-death vs exit-130 needs python3 to observe WIFSIGNALED"
	fi

	# 4. The scope of the kill, read off the command the REAL suite_reap composed.
	cmd="$(grep "^SSH<<.*ALETHIA_SUITE_TAG=" "$TMP/INT-group.log" | head -1)"
	case "$cmd" in
	*"tag='alethia-suite-s1-"*) ok "the kill is keyed on a tag unique to this run" ;;
	*) bad "no per-run tag in the reap command: $cmd" ;;
	esac
	case "$cmd" in
	*'pkill'* | *'killall'*) bad "the reap uses a blanket matcher: $cmd" ;;
	*) ok "no blanket pkill" ;;
	esac
	case "$cmd" in
	*"ALETHIA_SUITE_TAG=\$tag"*) ok "the remote match reads the supplied tag" ;;
	*) bad "the remote match does not use \$tag: $cmd" ;;
	esac
	# The self-filter is only real if the composed command line can actually match the pattern it
	# filters — i.e. dir carries its trailing slash. Without this the filter is decoration and its
	# mutation cannot go red.
	case "$cmd" in
	*"dir='/opt/alethia/envs/s1/'"*) ok "dir carries the trailing slash the self-filter needs" ;;
	*) bad "dir has no trailing slash, so the pgrep self-filter can never match: $cmd" ;;
	esac
	case "$cmd" in
	*'export tag='* | *'export dir='*) bad "tag/dir are exported — the reaper can now match itself" ;;
	*) ok "tag/dir stay unexported, so the reaper cannot become its own victim" ;;
	esac

	# 5. The remote script itself, against a fixture /proc. Selection is the part that must not be
	#    wrong: it decides what dies on a box other people are working on.
	raw="$TMP/reap.raw"
	awk "/^_SUITE_REAP_SH='\$/{f=1;next} f&&/^'\$/{exit} f" "$lib" >"$raw"
	[ -s "$raw" ] || bad "could not lift _SUITE_REAP_SH out of $lib"
	bash -n "$raw" 2>/dev/null || bad "the remote script is not valid shell"

	mkproc() {
		mkdir -p "$TMP/proc/$1"
		if [ "$2" = "-" ]; then
			printf 'PATH=/usr/bin\0HOME=/root\0' >"$TMP/proc/$1/environ"
		else
			printf 'PATH=/usr/bin\0ALETHIA_SUITE_TAG=%s\0HOME=/root\0' "$2" >"$TMP/proc/$1/environ"
		fi
	}
	TAG=alethia-suite-l6-cards-4242-1757500000
	mkproc 121475 "$TAG"                        # this run's vitest worker
	mkproc 121479 "$TAG"                        # …and another
	mkproc 200001 -                             # the env's own console: untagged
	mkproc 200002 alethia-suite-l6-cards-99-1   # a different run of the SAME slug
	mkproc 200003 alethia-suite-other-1-1       # another instance's suite
	mkproc 200004 "${TAG}x"                     # a tag this one is a PREFIX of

	compose() { # <killfile> <tag> <pgrep body>
		{
			echo "kill() { printf 'KILL %s\\n' \"\$*\" >>\"$1\"; }"
			echo "sleep() { :; }"
			echo "$3"
			echo "tag='$2'"
			echo "dir='/opt/alethia/envs/l6-cards/'"
			sed "s#/proc/#$TMP/proc/#g" "$raw"
		}
	}

	: >"$TMP/killed"
	compose "$TMP/killed" "$TAG" 'pgrep() { return 1; }' >"$TMP/reap.run"
	bash "$TMP/reap.run" >"$TMP/out" 2>&1
	got="$(sed -n 's/^KILL -TERM \([0-9]*\)$/\1/p' "$TMP/killed" | sort -u | tr '\n' ' ')"
	[ "$got" = "121475 121479 " ] || bad "TERM went to '$got', want exactly this run's two pids"
	got="$(sed -n 's/^KILL -KILL \([0-9]*\)$/\1/p' "$TMP/killed" | sort -u | tr '\n' ' ')"
	[ "$got" = "121475 121479 " ] || bad "the KILL sweep went to '$got', want the same two pids"
	for p in 200001 200002 200003 200004; do
		grep -q " $p\$" "$TMP/killed" && bad "signalled $p, which is not this run"
	done
	# `kill` is stubbed, so nothing actually died — which is what makes the SECOND tag pass
	# visible. "the box is clear of this run" must be a measurement, not a claim about a snapshot
	# taken before the sweep.
	if grep -q 'still carrying this run tag' "$TMP/out"; then
		ok "the clear-of-this-run claim is re-measured against the tag after the sweep"
	else
		bad "clear was asserted from the pre-TERM snapshot: $(cat "$TMP/out")"
	fi

	# 6. The no-match branch: kill NOTHING, report the evidence, and drop the reaper's own line.
	: >"$TMP/killed.none"
	compose "$TMP/killed.none" no-such-tag \
		'pgrep() { echo "$$ bash -c dir=/opt/alethia/envs/l6-cards/"; echo "121475 node /opt/alethia/envs/l6-cards/node_modules/vitest/dist/worker.js"; }' \
		>"$TMP/reap.none"
	bash "$TMP/reap.none" >"$TMP/out.none" 2>&1
	[ -s "$TMP/killed.none" ] && bad "the no-match branch killed something"
	grep -q '121475 node' "$TMP/out.none" || bad "the no-match branch reported no evidence"
	ev="$(grep -c '^      [0-9]' "$TMP/out.none")"
	[ "$ev" = 1 ] || bad "evidence lines: $ev, want 1 (the reaper's own line filtered out)"

	[ "$fails" = 0 ] || echo "probe($lib): $fails failed" >&2
	exit "$fails"
fi

# ── the orchestrator ──────────────────────────────────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "# 1-6: the shipped lib"
bash "$SELF" --probe "$LIB" || fails=$((fails + 1))
[ "$fails" = 0 ] && ok "every property holds for scripts/lib/env-suite-reap.sh"

# ── 7. the call sites, which no amount of testing the lib can reach ───────────────────────────
# A tag exported one line too early is not a defect in anything above: it is a correct reap with
# the wrong blast radius, and the blast radius is the whole safety argument.
echo "# 7: env.sh's call sites"
body() { sed -n "/^$1() {/,/^}/p" "$ENV_SH"; }

for fn in cmd_check cmd_test; do
	b="$(body "$fn")"
	[ -n "$b" ] || {
		bad "$fn is gone from env.sh"
		continue
	}
	grep -q 'suite_arm' <<<"$b" || bad "$fn does not arm the trap"
	grep -q 'suite_disarm' <<<"$b" || bad "$fn never disarms — a finished run would reap"
	# The ordering. `pnpm install` and `playwright install --with-deps` (apt/dpkg as root) must be
	# OUTSIDE the tagged region; a TERM-then-KILL through dpkg leaves the package database
	# interrupted for every other env on the shared box.
	tag_at="$(grep -n 'export ALETHIA_SUITE_TAG' <<<"$b" | head -1 | cut -d: -f1)"
	[ -n "$tag_at" ] || {
		bad "$fn never exports the tag — the reap can match nothing"
		continue
	}
	inst_at="$(grep -n 'pnpm install --frozen-lockfile' <<<"$b" | head -1 | cut -d: -f1)"
	if [ -n "$inst_at" ] && [ "$tag_at" -lt "$inst_at" ]; then
		bad "$fn tags its pnpm install — a Ctrl-C would kill it mid-write"
	fi
	apt_at="$(grep -n 'playwright install --with-deps' <<<"$b" | head -1 | cut -d: -f1)"
	if [ -n "$apt_at" ] && [ "$tag_at" -lt "$apt_at" ]; then
		bad "$fn tags 'playwright install --with-deps', which is apt/dpkg as root on a SHARED box"
	fi
done
grep -q 'lib/env-suite-reap.sh' "$ENV_SH" || bad "env.sh does not source the reap lib"
# cmd_test's failure branch ends in `exit 1`; disarming after the artefact fetch would fire the
# EXIT trap in the middle of it.
if sed -n '/tests failed — pulling the report/,/^  }/p' "$ENV_SH" | grep -q 'suite_disarm'; then
	bad "cmd_test disarms INSIDE its failure branch's tail rather than at its head"
fi
sed -n '/pnpm -F console exec playwright test \$proj" || {/,/^  }/p' "$ENV_SH" |
	head -2 | grep -q 'suite_disarm' ||
	bad "cmd_test's failure branch does not disarm FIRST"
[ "$fails" = 0 ] && ok "both call sites arm, disarm on every path, and tag only what they started"

# ── 8. the assertions above must be able to fail ──────────────────────────────────────────────
# Every row is a defect that shipped, or nearly did. #4 is the one that matters most: the private
# harness this test replaces stayed GREEN against it, and a false conclusion about bash's EXIT trap
# was written into a code comment on the strength of that.
echo "# 8: mutations (each must be caught)"
mutate() { # <name> <sed program|@disarm>
	local out="$TMP/$1.sh"
	if [ "$2" = "@disarm" ]; then
		cat "$LIB" >"$out"
		printf '\nsuite_disarm() { :; }\n' >>"$out"
	else
		sed "$2" "$LIB" >"$out"
	fi
	if cmp -s "$LIB" "$out"; then
		bad "mutation '$1' changed nothing — it is not testing what it names"
		return
	fi
	if bash "$SELF" --probe "$out" >/dev/null 2>&1; then
		bad "mutation '$1' went UNDETECTED — the assertions above prove less than they appear to"
	else
		ok "mutation '$1' caught"
	fi
}
mutate no-traps "/trap 'suite_reap/d"
mutate no-int-trap "/trap 'suite_reap || true; trap - INT/d"
mutate no-disarm '@disarm'
mutate cleanup-speaks-for-the-run 's/^\treturn "\$rc"$/\texit 0/'
mutate unanchored-tag-match 's/grep -Fqx/grep -Fq/'
mutate no-second-tag-pass 's/^  still=\$(tagged)$/  still=/'
mutate no-self-filter 's/ | grep -v "\^\$\$ "//'
mutate reap-status-aborts-the-handler 's/suite_reap || true; trap - INT/suite_reap; trap - INT/'
mutate dir-without-slash "s#envs/\$_suite_slug/'#envs/\$_suite_slug'#"

if [ "$fails" = 0 ]; then
	echo "env suite-reap: all passed"
else
	echo "env suite-reap: $fails failed" >&2
fi
exit "$fails"
