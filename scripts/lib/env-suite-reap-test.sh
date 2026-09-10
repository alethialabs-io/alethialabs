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
# INT while in `wait`, so removing the INT trap left that harness green and a comment claiming the
# EXIT trap alone covered it nearly shipped. In the real cmd_check shape — a FOREGROUND child and a
# signal delivered to the SCRIPT ALONE — bash abandons the wait and CONTINUES to suite_disarm, so
# no reap fires and an interrupted check returns 0. Section 3 runs both deliveries.
#
# AND THE CALL SITES ARE HALF THE SAFETY ARGUMENT, so they get their own mode and their own
# mutants. A tag exported one line too early is a correct reap with the wrong blast radius:
# `playwright install --with-deps` is apt/dpkg as root, and TERM-then-KILL through it leaves the
# package database interrupted for every other env on the box. The first version of that guard
# anchored on a line number taken from a COMMENT mentioning the command rather than the command
# itself, and passed the very defect it was written for — which is why section 7 strips comments
# before it counts anything, treats a missing anchor as a FAILURE rather than a skip, and is
# re-run in section 8 against mutated copies of env.sh.
#
#   bash scripts/lib/env-suite-reap-test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
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
	# The suite command carries the tag, exactly as both call sites compose it. Modelling it
	# WITHOUT the tag would make "how many reaps happened" answerable by grepping for the tag,
	# which is a property of the model rather than of the code.
	# shellcheck disable=SC2154  # $_suite_tag comes from the lib sourced above, as in env.sh.
	suite() { ssh_box "cd /opt/alethia/envs/s1 && pnpm install && export ALETHIA_SUITE_TAG='$_suite_tag' && $1"; }
	rc=0
	case "$5" in
	ok)
		suite_arm s1
		suite "run --pass" || rc=$?
		suite_disarm
		exit "$rc"
		;;
	red)
		suite_arm s1
		{ suite "run --fail"; false; } || rc=$?
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

# ── mode: every lib assertion, against ONE lib (the real one, or a mutant) ────────────────────
if [ "${1:-}" = "--probe" ]; then
	lib="$2"
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	# Job control: a background job started by a NON-interactive shell inherits SIGINT ignored, and
	# a trap cannot take back a signal inherited ignored. Without this the INT cases report "the
	# trap never fired" about a trap that was never given the chance — a false RED.
	set -m

	# Counted on `tagged() {`, which exists only in the reap script. NOT on the tag: the suite
	# command carries that too, so a tag count would report a reap on every passing run.
	# `|| true`, not `|| echo 0`: grep -c already PRINTS 0 when it matches nothing and exits 1.
	reaps() { grep -c 'tagged() {' "$1" 2>/dev/null || true; }
	child() { bash "$SELF" --child "$lib" "$2" "$TMP/ready" "$1" >/dev/null 2>&1; }

	# 1. A run that ENDS reaps nothing: green, red, and the exit code survives the trap.
	: >"$TMP/ok.log"
	rc=0
	child ok "$TMP/ok.log" || rc=$?
	[ "$rc" = 0 ] || bad "a passing run should exit 0, got $rc"
	[ "$(reaps "$TMP/ok.log")" = 0 ] || bad "a passing run reaped — it has nothing left to stop"
	grep -q 'run --pass' "$TMP/ok.log" || bad "the suite never ran"

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
	cmd="$(grep "^SSH<<.*tagged() {" "$TMP/INT-group.log" | head -1)"
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
	# THE REAPER MUST NOT BE FINDABLE BY ITS OWN PATTERN. `pgrep -af "$dir"` searches command
	# lines and this reap IS one, so the joined path may appear nowhere in it: the parts are sent
	# and the path is assembled on the box. A `$$` filter cannot substitute — the command
	# substitution around pgrep forks, and the fork has the same argv and a different pid.
	case "$cmd" in
	*"/opt/alethia/envs/s1/"*) bad "the joined env path is IN the reaper's command line: $cmd" ;;
	*) ok "the env path is assembled on the box, so pgrep's pattern cannot match the reaper" ;;
	esac
	case "$cmd" in
	*"base='/opt/alethia'"*) ok "the path is sent as parts" ;;
	*) bad "the reap command carries no base to assemble from: $cmd" ;;
	esac
	case "$cmd" in
	*'export tag='* | *'export base='* | *'export slug='*)
		bad "the prefix is exported — the reap's own helpers would carry the tag"
		;;
	*) ok "the prefix stays unexported, so nothing the reaper execs can carry the tag" ;;
	esac

	# 5. The remote script itself, against a fixture /proc. Selection is the part that must not be
	#    wrong: it decides what dies on a box other people are working on.
	raw="$TMP/reap.raw"
	awk "/^_SUITE_REAP_SH='\$/{f=1;next} f&&/^'\$/{exit} f" "$lib" >"$raw"
	[ -s "$raw" ] || bad "could not lift _SUITE_REAP_SH out of $lib"
	bash -n "$raw" 2>/dev/null || bad "the remote script is not valid shell"
	# The trailing slash is what stops `envs/l6` matching `envs/l6-cards` in the report.
	grep -q 'dir="\$base/envs/\$slug/"' "$raw" ||
		bad "the reported path has no trailing slash — a slug that is a prefix of another matches"

	mkproc() {
		mkdir -p "$TMP/proc/$1"
		if [ "$2" = "-" ]; then
			printf 'PATH=/usr/bin\0HOME=/root\0' >"$TMP/proc/$1/environ"
		else
			printf 'PATH=/usr/bin\0ALETHIA_SUITE_TAG=%s\0HOME=/root\0' "$2" >"$TMP/proc/$1/environ"
		fi
	}
	seed_proc() {
		rm -rf "$TMP/proc"
		mkproc 121475 "$TAG"                      # this run's vitest worker
		mkproc 121479 "$TAG"                      # …and another
		mkproc 200001 -                           # the env's own console: untagged
		mkproc 200002 alethia-suite-l6-cards-99-1 # a different run of the SAME slug
		mkproc 200003 alethia-suite-other-1-1     # another instance's suite
		mkproc 200004 "${TAG}x"                   # a tag this one is a PREFIX of
	}
	TAG=alethia-suite-l6-cards-4242-1757500000

	# `mortal`   — TERM works, so the fixture process disappears. A KILL sweep that re-derives
	#              from the tag has nothing left to sweep; one that reuses the TERM list signals
	#              pids that no longer belong to it, which on a shared box is somebody else's.
	# `immortal` — nothing dies, so the final pass must SAY so instead of claiming the box is
	#              clear from a snapshot taken before any signal was sent.
	compose() { # <mode> <killfile> <tag> <pgrep body>
		{
			if [ "$1" = mortal ]; then
				echo "kill() { printf 'KILL %s\\n' \"\$*\" >>\"$2\"; case \"\$1\" in -TERM) rm -rf \"$TMP/proc/\$2\" ;; esac; }"
			else
				echo "kill() { printf 'KILL %s\\n' \"\$*\" >>\"$2\"; }"
			fi
			echo "sleep() { :; }"
			echo "$4"
			echo "tag='$3'"
			echo "base='/opt/alethia'"
			echo "slug='l6-cards'"
			sed "s#/proc/#$TMP/proc/#g" "$raw"
		}
	}
	termed() { sed -n 's/^KILL -TERM \([0-9]*\)$/\1/p' "$1" | sort -u | tr '\n' ' '; }
	killed() { sed -n 's/^KILL -KILL \([0-9]*\)$/\1/p' "$1" | sort -u | tr '\n' ' '; }

	seed_proc
	: >"$TMP/k.mortal"
	compose mortal "$TMP/k.mortal" "$TAG" 'pgrep() { return 1; }' >"$TMP/r.mortal"
	bash "$TMP/r.mortal" >"$TMP/o.mortal" 2>&1
	[ "$(termed "$TMP/k.mortal")" = "121475 121479 " ] ||
		bad "TERM went to '$(termed "$TMP/k.mortal")', want exactly this run's two pids"
	[ -z "$(killed "$TMP/k.mortal")" ] ||
		bad "KILL went to '$(killed "$TMP/k.mortal")' — pids that TERM already retired, re-used by now"
	grep -q 'the box is clear of this run' "$TMP/o.mortal" ||
		bad "a run that did die was not reported clear: $(cat "$TMP/o.mortal")"
	for p in 200001 200002 200003 200004; do
		grep -q " $p\$" "$TMP/k.mortal" && bad "signalled $p, which is not this run"
	done

	seed_proc
	: >"$TMP/k.immortal"
	compose immortal "$TMP/k.immortal" "$TAG" 'pgrep() { return 1; }' >"$TMP/r.immortal"
	bash "$TMP/r.immortal" >"$TMP/o.immortal" 2>&1
	[ "$(killed "$TMP/k.immortal")" = "121475 121479 " ] ||
		bad "a process that survived TERM was not KILLed: '$(killed "$TMP/k.immortal")'"
	grep -q 'still carrying this run tag' "$TMP/o.immortal" ||
		bad "clear was claimed while two pids still carry the tag: $(cat "$TMP/o.immortal")"

	# 6. The no-match branch: kill NOTHING and report the evidence.
	#
	# THE pgrep STUB IS COMPOSED — one hand-written line — so nothing here can establish what real
	# `pgrep -af` output looks like, and in particular it cannot establish that the reaper is
	# absent from it. That property is asserted in section 4 instead, against the command line
	# suite_reap actually built: if the joined path is not in the reaper's own argv, no pgrep can
	# return it, whatever its output looks like. Checked end to end once, off-CI, with a ps-backed
	# pgrep: the joined form lists the reaper AND its fork (identical argv, different pid, which is
	# why a `$$` filter cannot work); the assembled form lists neither.
	seed_proc
	: >"$TMP/k.none"
	compose immortal "$TMP/k.none" no-such-tag \
		'pgrep() { echo "121475 node /opt/alethia/envs/l6-cards/node_modules/vitest/dist/worker.js"; }' \
		>"$TMP/r.none"
	bash "$TMP/r.none" >"$TMP/o.none" 2>&1
	[ -s "$TMP/k.none" ] && bad "the no-match branch killed something"
	grep -q '121475 node' "$TMP/o.none" || bad "the no-match branch reported no evidence"

	[ "$fails" = 0 ] || echo "probe($lib): $fails failed" >&2
	exit "$fails"
fi

# ── mode: the call sites, against ONE env.sh (the real one, or a mutant) ──────────────────────
# No amount of testing the lib reaches these: arming after the run leaves the whole fix inert, and
# a tag exported one line early is a correct reap with the wrong blast radius.
if [ "${1:-}" = "--callsites" ]; then
	env_sh="$2"

	# COMMENTS STRIPPED BEFORE ANYTHING IS COUNTED. Every anchor below also appears in prose that
	# explains it — `playwright install --with-deps` three times in cmd_test, twice in comments —
	# and `head -1` on the un-stripped body takes the first COMMENT. That is not a weak guard, it
	# is an inverted one: with the install anchor resolving to a comment above the export and the
	# pnpm-install anchor resolving to real code below it, the only position that passed was the
	# defect itself.
	body() { sed -n "/^$1() {/,/^}/p" "$env_sh" | grep -v '^[[:space:]]*#'; }

	# A MISSING ANCHOR IS A FAILURE, never a skip. `if [ -n "$x" ] && …` reads like a guard and
	# behaves like an opt-out: rename the command it looks for and the assertion evaporates
	# silently, which is the failure mode an exception ledger is supposed to make loud.
	at() { # <function> <label> <literal anchor> <body>
		local n
		n="$(grep -n -F "$3" <<<"$4" | head -1 | cut -d: -f1)"
		if [ -z "$n" ]; then
			bad "$1: the '$2' anchor ('$3') is gone — this assertion would have passed vacuously"
			echo 0
			return
		fi
		echo "$n"
	}

	for fn in cmd_check cmd_test; do
		b="$(body "$fn")"
		[ -n "$b" ] || {
			bad "$fn is gone from env.sh"
			continue
		}
		arm_at="$(at "$fn" arm 'suite_arm' "$b")"
		dis_at="$(at "$fn" disarm 'suite_disarm' "$b")"
		tag_at="$(at "$fn" tag 'export ALETHIA_SUITE_TAG' "$b")"
		inst_at="$(at "$fn" install 'pnpm install --frozen-lockfile' "$b")"
		# THE RUN is not "the first ssh_box in this function" — cmd_test opens with two others (the
		# registry lookup and the edition probe), and anchoring on the first named the wrong one.
		# It is the ssh_box whose command string carries the tag: the LAST one at or before the
		# export. Derived from tag_at so the two can never drift apart.
		run_at="$(grep -n 'ssh_box "' <<<"$b" | cut -d: -f1 |
			awk -v t="$tag_at" '$1 < t { n = $1 } END { print n + 0 }')"
		[ "$run_at" != 0 ] ||
			bad "$fn: no ssh_box invocation carries the tag export — the run cannot be located"

		[ "$arm_at" != 0 ] && [ "$run_at" != 0 ] && [ "$arm_at" -lt "$run_at" ] ||
			bad "$fn arms the trap at line $arm_at, AFTER the run at $run_at — nothing is armed for it"
		[ "$dis_at" != 0 ] && [ "$run_at" != 0 ] && [ "$dis_at" -gt "$run_at" ] ||
			bad "$fn disarms at $dis_at, before the run at $run_at"
		[ "$tag_at" != 0 ] && [ "$inst_at" != 0 ] && [ "$tag_at" -gt "$inst_at" ] ||
			bad "$fn tags its pnpm install (tag $tag_at, install $inst_at) — a Ctrl-C kills it mid-write"

		if [ "$fn" = cmd_test ]; then
			apt_at="$(at "$fn" apt 'playwright install --with-deps' "$b")"
			[ "$apt_at" != 0 ] && [ "$tag_at" != 0 ] && [ "$tag_at" -gt "$apt_at" ] ||
				bad "cmd_test tags 'playwright install --with-deps' (tag $tag_at, apt $apt_at) — that is apt/dpkg as root on a SHARED box"
			# The failure branch ends in `exit 1`, so disarming after the artefact fetch would fire
			# the EXIT trap in the middle of it.
			fetch_at="$(at "$fn" fetch 'fetch_artifacts' "$b")"
			[ "$fetch_at" != 0 ] && [ "$dis_at" -lt "$fetch_at" ] ||
				bad "cmd_test disarms at $dis_at, after the failure branch's fetch at $fetch_at"
		fi
	done
	grep -q 'lib/env-suite-reap.sh' "$env_sh" || bad "env.sh does not source the reap lib"

	[ "$fails" = 0 ] || echo "callsites($env_sh): $fails failed" >&2
	exit "$fails"
fi

# ── the orchestrator ──────────────────────────────────────────────────────────────────────────
ENV_SH="$ROOT/scripts/env.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "# 1-6: the shipped lib"
bash "$SELF" --probe "$LIB" || fails=$((fails + 1))
[ "$fails" = 0 ] && ok "every property holds for scripts/lib/env-suite-reap.sh"

echo "# 7: env.sh's call sites"
bash "$SELF" --callsites "$ENV_SH" || fails=$((fails + 1))
[ "$fails" = 0 ] && ok "both call sites arm before the run, disarm after it, and tag only what they started"

# ── 8. the assertions above must be able to fail ──────────────────────────────────────────────
# Every row is a defect that shipped, or nearly did. The env.sh rows are here because the first
# version of section 7 had none: nine mutants all edited the lib, so not one call-site assertion
# had ever been shown capable of failing — while the defect it was written for was a call site.
echo "# 8: mutations (each must be caught)"
detect() { # <mode> <name> <file>
	if bash "$SELF" "$1" "$3" >/dev/null 2>&1; then
		bad "mutation '$2' went UNDETECTED — the assertions above prove less than they appear to"
	else
		ok "mutation '$2' caught"
	fi
}
mutate_lib() { # <name> <sed program|@disarm>
	local out="$TMP/lib-$1.sh"
	if [ "$2" = "@disarm" ]; then
		cat "$LIB" >"$out"
		printf '\nsuite_disarm() { :; }\n' >>"$out"
	else
		sed "$2" "$LIB" >"$out"
	fi
	cmp -s "$LIB" "$out" && {
		bad "mutation '$1' changed nothing — it is not testing what it names"
		return
	}
	detect --probe "$1" "$out"
}
mutate_env() { # <name> — reads the program from stdin, applied by awk
	local out="$TMP/env-$1.sh"
	awk -f /dev/stdin "$ENV_SH" >"$out"
	cmp -s "$ENV_SH" "$out" && {
		bad "mutation '$1' changed nothing — it is not testing what it names"
		return
	}
	detect --callsites "$1" "$out"
}

mutate_lib no-traps "/trap 'suite_reap/d"
mutate_lib no-int-trap "/trap 'suite_reap || true; trap - INT/d"
mutate_lib no-disarm '@disarm'
mutate_lib cleanup-speaks-for-the-run 's/^\treturn "\$rc"$/\texit 0/'
mutate_lib unanchored-tag-match 's/grep -Fqx/grep -Fq/'
mutate_lib reap-status-aborts-the-handler 's/suite_reap || true; trap - INT/suite_reap; trap - INT/'
mutate_lib kill-a-stale-pid-list 's/^  for p in \$(tagged); do kill -KILL/  for p in \$pids; do kill -KILL/'
mutate_lib no-final-tag-pass 's/^  still=\$(tagged)$/  still=/'
mutate_lib path-back-in-the-command-line "s/base='\\\$REMOTE' slug='\\\$_suite_slug'/base='\\\$REMOTE' slug='\\\$_suite_slug' d='\\\$REMOTE\\/envs\\/\\\$_suite_slug\\/'/"
mutate_lib reported-path-without-slash 's|^dir="\$base/envs/\$slug/"$|dir="$base/envs/$slug"|'

# The F4 defect, verbatim: the tag exported between the two installs, so apt/dpkg as root is back
# inside the blast radius. This is the mutation the comment-anchored guard passed green.
mutate_env tag-between-the-installs <<'AWK'
/^    export ALETHIA_SUITE_TAG/ { next }
{ print }
/^    pnpm install --frozen-lockfile >\/dev\/null$/ { print "    export ALETHIA_SUITE_TAG=\047$_suite_tag\047" }
AWK

# Arming after the run leaves the entire fix inert, with no trap set for the whole suite.
mutate_env arm-after-the-run <<'AWK'
/^  suite_arm "\$slug_"$/ && !done_del { done_del = 1; next }
{ print }
/--minWorkers=\$workers" \|\| rc=\$\?$/ { print "  suite_arm \"$slug_\"" }
AWK

# Renaming an anchor must FAIL, not silently skip the assertion built on it.
mutate_env install-anchor-renamed <<'AWK'
{ sub(/pnpm install --frozen-lockfile/, "pnpm i --frozen-lockfile"); print }
AWK
mutate_env apt-anchor-renamed <<'AWK'
{ sub(/playwright install --with-deps/, "playwright install --deps"); print }
AWK
mutate_env no-disarm-at-all <<'AWK'
/^ *suite_disarm$/ { next }
{ print }
AWK

if [ "$fails" = 0 ]; then
	echo "env suite-reap: all passed"
else
	echo "env suite-reap: $fails failed" >&2
fi
exit "$fails"
