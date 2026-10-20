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
	# WHAT PROTECTS THE REAPER IS THE NAMES, not the absence of an `export`. `grep -Fqx` matches a
	# whole line, so an exported `tag=<value>` could never satisfy `ALETHIA_SUITE_TAG=<value>`; the
	# edit that would break it is exporting a prefix variable UNDER THAT NAME, after which the
	# `tr` and `grep` the loop execs carry the tag and the run can never read clear. So the check
	# is on the prefix — everything before the script — and on the name.
	case "${cmd%%;*}" in
	*ALETHIA_SUITE_TAG*)
		bad "the reap's prefix names ALETHIA_SUITE_TAG: its own tr/grep would match, and it would report itself as a survivor"
		;;
	*) ok "the prefix names no ALETHIA_SUITE_TAG, so nothing the reaper execs can carry the tag" ;;
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
#
# THIS COMPARES BYTE OFFSETS, not line numbers, and the difference is a defect this guard has now
# been through twice. Line numbers of MENTIONS say nothing about the order in which the box runs
# things: hoist the installs into a variable above the export and interpolate it below —
#
#     local warm="pnpm install --frozen-lockfile >/dev/null
#       pnpm -F console exec playwright install --with-deps chromium >/dev/null"
#     ssh_box "… export ALETHIA_SUITE_TAG=… ; $warm"
#
# — and every mention still appears in an order the old checks accepted, while apt runs INSIDE the
# blast radius. Offsets plus a "mentioned exactly once" count close that: the install anchor has to
# occur once and that once has to sit after the run's own `ssh_box`.
#
# TWO RESIDUALS, stated rather than implied away by "asserts the ordering against env.sh's source":
#
#   1. A remote SHELL FUNCTION — `warm() { pnpm install …; }` defined above the export and called
#      below it — is out of reach of ANY textual guard, because the text and the execution order
#      genuinely differ and only a shell can say how. Nothing here catches it.
#   2. This validates ONE run per function, which is why it requires exactly one tag export per
#      call site: a second tag-exporting `ssh_box` added after `suite_disarm` is unarmed for its
#      whole life, and counting is what makes it visible. A call site that legitimately needed two
#      runs would have to be read by something that parses shell, and this guard would refuse it
#      rather than quietly check the first.
if [ "${1:-}" = "--callsites" ]; then
	env_sh="$2"
	[ -r "$env_sh" ] || {
		echo "FAIL - $env_sh is not readable" >&2
		exit 3
	}

	# COMMENTS STRIPPED BEFORE ANYTHING IS COUNTED. Every anchor below also appears in prose that
	# explains it — `playwright install --with-deps` three times in cmd_test, twice in comments —
	# and the first version of this section took `head -1` of the un-stripped body and landed on a
	# COMMENT. That is not a weak guard, it is an inverted one: with the apt anchor resolving to a
	# comment above the export and the pnpm-install anchor resolving to real code below it, the
	# only export position that passed was the defect itself.
	body() { sed -n "/^$1() {/,/^}/p" "$env_sh" | grep -v '^[[:space:]]*#'; }

	# PURE, both of them, and that is not a style preference. They are called inside `$( )`, which
	# forks — a `fails=$((fails+1))` in there never reaches this shell, so a helper that reported
	# its own verdicts would be a vacuous-pass detector that could not itself fail the run. Every
	# verdict below is reached in the parent.
	off() { # <needle> <blob> → byte offset of the first occurrence, or -1
		local o
		o="$(printf '%s' "$2" | grep -boF -- "$1" | head -1 | cut -d: -f1)"
		echo "${o:--1}"
	}
	mentions() { printf '%s' "$2" | grep -coF -- "$1"; }
	ordered() { # <fn> <what> <lo-offset> <hi-offset>
		if [ "$3" -ge 0 ] && [ "$4" -ge 0 ] && [ "$3" -lt "$4" ]; then
			return 0
		fi
		bad "$1: $2 (offsets $3 then $4)"
	}

	# The VALUE, not just the variable: `export ALETHIA_SUITE_TAG=hello` would degrade the reap to
	# report-only — fail-safe, and completely silent — so the anchor is the whole assignment.
	TAG_LIT="export ALETHIA_SUITE_TAG='\$_suite_tag'"

	for fn in cmd_check cmd_test; do
		b="$(body "$fn")"
		[ -n "$b" ] || {
			bad "$fn is gone from env.sh"
			continue
		}

		n="$(mentions "$TAG_LIT" "$b")"
		[ "$n" = 1 ] ||
			bad "$fn carries $n copies of $TAG_LIT (want exactly 1) — a second run this guard never located, or none at all"
		n="$(mentions 'pnpm install --frozen-lockfile' "$b")"
		[ "$n" = 1 ] ||
			bad "$fn mentions 'pnpm install --frozen-lockfile' $n times — the offsets below would describe one occurrence while the box runs another"

		arm_o="$(off 'suite_arm' "$b")"
		dis_o="$(off 'suite_disarm' "$b")"
		tag_o="$(off "$TAG_LIT" "$b")"
		inst_o="$(off 'pnpm install --frozen-lockfile' "$b")"
		# THE RUN is not "the first ssh_box in this function" — cmd_test opens with two others (the
		# registry lookup and the edition probe), and anchoring on the first named the wrong one.
		# It is the last `ssh_box "` that begins before the export, by byte offset: on a single-line
		# `&&` chain that is the same line, which a line-number comparison could not express.
		run_o="$(printf '%s' "$b" | grep -boF 'ssh_box "' | cut -d: -f1 |
			awk -v t="$tag_o" '$1 < t { n = $1 } END { print (n == "" ? -1 : n) }')"

		[ "$run_o" -ge 0 ] ||
			bad "$fn: no ssh_box begins before the tag export — the run cannot be located"
		ordered "$fn" "arms the trap before the run, not after it" "$arm_o" "$run_o"
		ordered "$fn" "runs its install INSIDE the run's own command, not hoisted above it" "$run_o" "$inst_o"
		ordered "$fn" "tags AFTER its pnpm install — a Ctrl-C would kill it mid-write" "$inst_o" "$tag_o"
		ordered "$fn" "disarms after the run" "$tag_o" "$dis_o"

		if [ "$fn" = cmd_test ]; then
			n="$(mentions 'playwright install --with-deps' "$b")"
			[ "$n" = 1 ] ||
				bad "cmd_test mentions 'playwright install --with-deps' $n times — one of them is the executed one and the offsets cannot say which"
			apt_o="$(off 'playwright install --with-deps' "$b")"
			ordered cmd_test "runs the browser install inside the run's command" "$run_o" "$apt_o"
			ordered cmd_test "tags AFTER 'playwright install --with-deps', which is apt/dpkg as root on a SHARED box" "$apt_o" "$tag_o"
			# The failure branch ends in `exit 1`, so disarming after the artefact fetch would fire
			# the EXIT trap in the middle of it.
			fetch_o="$(off 'fetch_artifacts' "$b")"
			ordered cmd_test "disarms before its failure branch fetches artefacts" "$dis_o" "$fetch_o"
		fi
	done
	grep -q 'lib/env-suite-reap.sh' "$env_sh" || bad "env.sh does not source the reap lib"

	[ "$fails" = 0 ] || echo "callsites($env_sh): $fails failed" >&2
	exit "$fails"
fi

# ── mode: env.sh's two status contracts, DRIVEN rather than read ──────────────────────────────
# Both of these shipped broken out of this issue's own work, and neither is visible to a guard
# that reads text: they are about what a status IS, under an errexit that a caller can suspend.
#
# The functions are lifted verbatim out of env.sh and given stubs, the same way the remote script
# is lifted for the fixture — so these assertions are about the shipped text, not a copy.
if [ "${1:-}" = "--functions" ]; then
	env_sh="$2"
	[ -r "$env_sh" ] || {
		echo "FAIL - $env_sh is not readable" >&2
		exit 3
	}
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	for f in push_tree ssh_box read_registry; do
		sed -n "/^$f() {/,/^}/p" "$env_sh" >"$TMP/$f.sh"
		[ -s "$TMP/$f.sh" ] || bad "could not lift $f() out of $env_sh"
	done

	# A. push_tree's status is the RSYNC's — not the registry touch's, and not nothing.
	#
	# `cmd_push --watch` runs `push_tree && build_ee && echo pushed`, and as the left operand of
	# `&&` push_tree runs with errexit SUSPENDED for its whole body. So a trailing
	# `ssh_box … || echo …` — which always returns 0 — took the rsync's status out along with the
	# touch's, and a failed push went on to rebuild ee/dist from the stale tree and print "pushed"
	# for the rest of the session. The plain `env:push` path kept working, which is why only the
	# watch shape can catch it.
	cat >"$TMP/drive-push.sh" <<'SH'
set -euo pipefail
LOG="$1"; RSYNC_RC="$2"; TOUCH_RC="$3"
ROOT=/tmp/nonexistent; REMOTE=/opt/alethia
require_box() { printf '1.2.3.4'; }
slug() { printf 's1'; }
rsync() { echo RSYNC >>"$LOG"; return "$RSYNC_RC"; }
ssh_box() { echo TOUCH >>"$LOG"; return "$TOUCH_RC"; }
build_ee() { echo BUILD >>"$LOG"; }
. "$4"
push_tree && build_ee && echo PUSHED >>"$LOG"
SH
	push_case() { # <label> <rsync-rc> <touch-rc>
		: >"$TMP/push.log"
		bash "$TMP/drive-push.sh" "$TMP/push.log" "$2" "$3" "$TMP/push_tree.sh" >/dev/null 2>&1
		echo "$?"
	}
	before="$fails"

	rc="$(push_case fail 1 0)"
	[ "$rc" != 0 ] || bad "a failed rsync left the watch chain succeeding (status $rc)"
	grep -q BUILD "$TMP/push.log" &&
		bad "a failed rsync still reached build_ee — ee/dist would be rebuilt from a stale tree"
	grep -q PUSHED "$TMP/push.log" &&
		bad "a failed rsync still printed 'pushed'"

	rc="$(push_case ok 0 0)"
	[ "$rc" = 0 ] || bad "a good push returned $rc"
	grep -q BUILD "$TMP/push.log" || bad "a good push did not reach build_ee"
	grep -q TOUCH "$TMP/push.log" || bad "a good push did not record activity"

	rc="$(push_case touch-fails 0 1)"
	[ "$rc" = 0 ] || bad "a registry hiccup failed a good push (status $rc)"
	grep -q BUILD "$TMP/push.log" || bad "a registry hiccup stopped build_ee"
	# CONDITIONAL. An unconditional summary line prints "ok" underneath its own failures, which is
	# the shape of every guard that reports green while measuring red.
	[ "$fails" = "$before" ] &&
		ok "push_tree's status is the rsync's: a failed push stops the watch chain, a failed touch does not"

	# A2. push_tree does not ship local junk, and still ships untracked source (#6110).
	#
	# Driven through a REAL rsync into a local directory — the stub only drops `-e ssh` and swaps
	# the remote destination — so what is asserted is what rsync actually copied under push_tree's
	# filters, not how the argument list happens to be spelled.
	if command -v rsync >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
		src="$TMP/push-src"
		dst="$TMP/push-dst"
		mkdir -p "$src/apps/console" "$src/.github" "$src/.pnpm-store/v3" "$src/.codex-run-base/x" \
			"$src/.newcache" "$src/newpkg" "$dst"
		echo tracked >"$src/apps/console/page.ts"
		echo tracked >"$src/.github/ci.yml"
		git -C "$src" init -q
		git -C "$src" add apps .github
		echo store >"$src/.pnpm-store/v3/blob"
		echo base >"$src/.codex-run-base/x/copy"
		echo cache >"$src/.newcache/c"
		echo new >"$src/apps/console/new-untracked.ts"
		echo new >"$src/.github/new-untracked.yml"
		echo new >"$src/newpkg/index.ts"
		cat >"$TMP/drive-excl.sh" <<'SH'
set -euo pipefail
ROOT="$1"; DST="$2"; REMOTE=/opt/alethia
require_box() { printf '1.2.3.4'; }
slug() { printf 's1'; }
ssh_box() { :; }
rsync() {
	local a=() skip=0 x
	for x in "$@"; do
		if [ "$skip" = 1 ]; then skip=0; continue; fi
		[ "$x" = "-e" ] && { skip=1; continue; }
		a+=("$x")
	done
	unset 'a[${#a[@]}-1]'
	command rsync "${a[@]}" "$DST/"
}
. "$3"
push_tree
SH
		bash "$TMP/drive-excl.sh" "$src" "$dst" "$TMP/push_tree.sh" >/dev/null 2>&1 ||
			bad "push_tree failed against a local rsync"
		before="$fails"
		for junk in .pnpm-store .codex-run-base .newcache; do
			[ -e "$dst/$junk" ] && bad "push_tree shipped $junk/ — local junk reaches the box"
		done
		for want in apps/console/page.ts apps/console/new-untracked.ts .github/ci.yml \
			.github/new-untracked.yml newpkg/index.ts; do
			[ -e "$dst/$want" ] || bad "push_tree withheld $want — the working tree must ship, untracked source included"
		done
		# The static half must hold where git cannot be asked.
		for junk in .pnpm-store .codex-run-base; do
			grep -Fq -- "--exclude=/$junk" "$TMP/push_tree.sh" ||
				bad "push_tree's static exclude list does not name /$junk"
		done
		[ "$fails" = "$before" ] &&
			ok "push_tree excludes .pnpm-store, .codex-run-base and untracked top-level dot-dirs, and still ships untracked source"
	else
		bad "rsync and git are required to drive push_tree's excludes"
	fi

	# B. ssh_box RETURNS on an unreachable box; it does not exit the caller's shell.
	#
	# `exit` inside a function ends the shell, so `|| true` cannot catch it — it never returns to
	# be caught. Inside `$( )` the exit is confined to the subshell, which is the reassuring half
	# and not the operative one: the ASSIGNMENT then carries status 1 and errexit aborts the
	# caller. read_registry documents itself as failing CLOSED, and `reg="$(read_registry)"` in
	# cmd_reap_dry_run became a mute abort — require_box's message swallowed by its own 2>/dev/null.
	cat >"$TMP/drive-ssh.sh" <<'SH'
set -euo pipefail
REMOTE=/opt/alethia
require_box() { echo "✗ the sandbox box is not up" >&2; exit 1; }
forget_stale_host_key() { :; }
ssh() { echo "SSH-RAN" ; return 0; }
. "$1"
. "$2"
ssh_box "anything" 2>/dev/null || echo CAUGHT
reg="$(read_registry)"
[ -z "$reg" ] || echo "NOT-EMPTY"
echo SURVIVED
SH
	out="$(bash "$TMP/drive-ssh.sh" "$TMP/ssh_box.sh" "$TMP/read_registry.sh" 2>/dev/null)"
	rc=$?
	case "$out" in
	*CAUGHT*) ok "a caller's '|| …' can catch an unreachable box — ssh_box returns, it does not exit" ;;
	*) bad "'|| …' never saw a status: ssh_box ended the shell instead of returning" ;;
	esac
	case "$out" in
	*SURVIVED*) ok "read_registry still fails CLOSED: empty answer, status 0, caller alive" ;;
	*) bad "read_registry's documented fail-closed contract is broken — the caller died (rc $rc)" ;;
	esac
	case "$out" in
	*SSH-RAN*) bad "ssh ran with an empty ip — require_box's failure did not stop it" ;;
	*NOT-EMPTY*) bad "read_registry returned content from an unreachable box" ;;
	esac

	# C. An EXISTING env's .env is reconciled, not left behind (#6111).
	#
	# The `dev` env predated ALETHIA_SANDBOX=1, and `test -f … || cat >` meant no env:up would ever
	# give it the key: sign-in codes went nowhere and nothing was red. dotenv_reconcile runs ON THE
	# BOX as text shipped by `declare -f`, so it is driven here the same way — under `sh`, not the
	# bash that defined it.
	for f in dotenv_template dotenv_secret_keys dotenv_required_keys dotenv_reconcile env_dotenv_gaps \
		dotenv_edition edition_row edition_rows edition_pin_note; do
		sed -n "/^$f() {/,/^}$/p" "$env_sh" >>"$TMP/dotenv.sh"
		grep -q "^$f() {" "$TMP/dotenv.sh" || bad "could not lift $f() out of $env_sh"
	done
	cat >"$TMP/drive-dotenv.sh" <<'SH'
set -euo pipefail
. "$1"; shift
file="$1" fresh="$2"
render() { dotenv_template s1 3100 8400 db_s1 https://s1.example NEWSECRET1 NEWSECRET2 NEWSECRET3 \
	NEWSECRET4 NEWOIDC NEWRECEIPT NEWSNAPSHOT NEWBOOTSTRAP "${EDITION:-enterprise}"; }
# shellcheck disable=SC2046
render | sh -c "$(declare -f dotenv_reconcile); dotenv_reconcile \"\$@\"" sh "$file" "$fresh" $(dotenv_secret_keys)
SH
	# An env as `dev` was: minted before ALETHIA_SANDBOX, ALETHIA_LICENSE_ACTIVE and ALETHIA_EDITION
	# (#6158 — it ran `auto`, the one mode prod never runs), one value edited
	# by hand, no trailing newline. Its secrets must come through byte-for-byte.
	legacy() { # <file> [drop-key]
		dotenv_render_old >"$1.full"
		grep -v -e '^ALETHIA_SANDBOX=' -e '^ALETHIA_LICENSE_ACTIVE=' -e '^ALETHIA_EDITION=' ${2:+-e "^$2="} "$1.full" |
			sed 's/^ALETHIA_DB_PORT=5433$/ALETHIA_DB_PORT=6543/' >"$1.tmp"
		printf '%s' "$(cat "$1.tmp")" >"$1"
		rm -f "$1.full" "$1.tmp"
	}
	dotenv_render_old() {
		bash -c '. "$1"; dotenv_template s1 3100 8400 db_s1 https://s1.example OLDSECRET1 OLDSECRET2 \
			OLDSECRET3 OLDSECRET4 OLDOIDC OLDRECEIPT OLDSNAPSHOT OLDBOOTSTRAP' _ "$TMP/dotenv.sh"
	}
	before="$fails"
	dv="$TMP/dotenv-case"
	mkdir -p "$dv"

	# C1. No file: the whole render, as before.
	out="$(bash "$TMP/drive-dotenv.sh" "$TMP/dotenv.sh" "$dv/new.env" "" 2>&1)" || bad "a first mint failed: $out"
	grep -qx 'ALETHIA_SANDBOX=1' "$dv/new.env" || bad "a first mint did not write ALETHIA_SANDBOX=1"
	grep -qx 'BETTER_AUTH_SECRET=NEWSECRET1' "$dv/new.env" || bad "a first mint did not write its secrets"
	grep -qx 'ALETHIA_EDITION=enterprise' "$dv/new.env" ||
		bad "a first mint left ALETHIA_EDITION unpinned (auto) — prod pins enterprise (#6158)"
	# C1b. A community-pinned mint pins community, and nothing else.
	out="$(EDITION=community bash "$TMP/drive-dotenv.sh" "$TMP/dotenv.sh" "$dv/comm.env" "" 2>&1)" ||
		bad "a community mint failed: $out"
	grep -qx 'ALETHIA_EDITION=community' "$dv/comm.env" || bad "env:up --community did not pin community"
	[ "$(grep -c '^ALETHIA_EDITION=' "$dv/comm.env")" = 1 ] || bad "a community mint wrote more than one edition"

	# C2. The `dev` shape: the static keys are appended, nothing present is touched.
	legacy "$dv/old.env"
	cp "$dv/old.env" "$dv/old.orig"
	rc=0
	out="$(bash "$TMP/drive-dotenv.sh" "$TMP/dotenv.sh" "$dv/old.env" "" 2>&1)" || rc=$?
	[ "$rc" = 0 ] || bad "reconciling static keys returned $rc: $out"
	grep -qx 'ALETHIA_SANDBOX=1' "$dv/old.env" ||
		bad "an env minted before ALETHIA_SANDBOX still lacks it after env:up — #6111 unfixed"
	grep -qx 'ALETHIA_LICENSE_ACTIVE=false' "$dv/old.env" || bad "ALETHIA_LICENSE_ACTIVE was not reconciled"
	grep -qx 'ALETHIA_EDITION=enterprise' "$dv/old.env" ||
		bad "an env minted before the edition pin is still unpinned after env:up — #6158 unfixed"
	# The original bytes are a PREFIX of the result: appended, never rewritten. The missing
	# trailing newline must not glue the first new key onto the last old line.
	head -c "$(wc -c <"$dv/old.orig")" "$dv/old.env" | cmp -s - "$dv/old.orig" ||
		bad "reconciling REWROTE the existing .env instead of appending to it"
	grep -q 'NEWSECRET\|NEWOIDC\|NEWRECEIPT\|NEWSNAPSHOT\|NEWBOOTSTRAP' "$dv/old.env" &&
		bad "reconciling replaced or duplicated a secret the env already had"
	grep -qx 'ALETHIA_DB_PORT=6543' "$dv/old.env" || bad "a hand-edited value did not survive"
	[ "$(grep -c '^ALETHIA_DB_PORT=' "$dv/old.env")" = 1 ] || bad "a present key was appended a second time"
	case "$out" in
	*OLD[A-Z]*[0-9A-Z]* | *NEW[A-Z]*[0-9A-Z]*) bad "reconcile printed a VALUE: $out" ;;
	esac
	case "$out" in
	*"added: ALETHIA_SANDBOX ALETHIA_LICENSE_ACTIVE ALETHIA_EDITION"*) ;;
	*) bad "reconcile did not name the keys it added: $out" ;;
	esac
	# Idempotent: a second env:up adds nothing.
	cp "$dv/old.env" "$dv/old.once"
	bash "$TMP/drive-dotenv.sh" "$TMP/dotenv.sh" "$dv/old.env" "" >/dev/null 2>&1 || bad "a second reconcile failed"
	cmp -s "$dv/old.env" "$dv/old.once" || bad "a second env:up changed an already-reconciled .env"

	# C2b. A hand-pinned community env is the pin, not drift: a default env:up keeps it.
	legacy "$dv/pin.env"
	printf '\nALETHIA_EDITION=community\n' >>"$dv/pin.env"
	bash "$TMP/drive-dotenv.sh" "$TMP/dotenv.sh" "$dv/pin.env" "" >/dev/null 2>&1 || bad "reconciling a pinned env failed"
	[ "$(grep '^ALETHIA_EDITION=' "$dv/pin.env")" = "ALETHIA_EDITION=community" ] ||
		bad "env:up overrode or duplicated a community pin: $(grep '^ALETHIA_EDITION=' "$dv/pin.env" | tr '\n' ' ')"

	# C3. A missing SECRET is refused with status 3 and its name — not minted into a live env —
	# while the static keys still land.
	legacy "$dv/sec.env" BETTER_AUTH_SECRET
	rc=0
	out="$(bash "$TMP/drive-dotenv.sh" "$TMP/dotenv.sh" "$dv/sec.env" "" 2>&1)" || rc=$?
	[ "$rc" = 3 ] || bad "a missing secret returned $rc, not the refusal (3)"
	case "$out" in
	*"secret-missing: BETTER_AUTH_SECRET"*) ;;
	*) bad "the refusal does not name the missing secret: $out" ;;
	esac
	case "$out" in
	*OLD[A-Z]*[0-9A-Z]* | *NEW[A-Z]*[0-9A-Z]*) bad "the refusal printed a VALUE: $out" ;;
	esac
	grep -q '^BETTER_AUTH_SECRET=' "$dv/sec.env" && bad "a secret was minted into a LIVE env without --fresh"
	grep -qx 'ALETHIA_SANDBOX=1' "$dv/sec.env" || bad "a missing secret blocked the static keys as well"

	# C4. Under --fresh (the database is about to be dropped) the missing secret is minted.
	rc=0
	bash "$TMP/drive-dotenv.sh" "$TMP/dotenv.sh" "$dv/sec.env" fresh >/dev/null 2>&1 || rc=$?
	[ "$rc" = 0 ] || bad "env:up --fresh still refused a missing secret (status $rc)"
	grep -qx 'BETTER_AUTH_SECRET=NEWSECRET1' "$dv/sec.env" || bad "--fresh did not mint the missing secret"
	grep -qx 'CLI_JWT_SECRET=OLDSECRET2' "$dv/sec.env" || bad "--fresh rotated a secret that was present"

	# C5. The secret classification is DERIVED from the template; pin that it says the right thing.
	secrets="$(bash -c '. "$1"; dotenv_secret_keys' _ "$TMP/dotenv.sh" | tr '\n' ' ')"
	for k in BETTER_AUTH_SECRET ALETHIA_OIDC_SIGNING_KEY ALETHIA_APP_DATABASE_URL ALETHIA_CRED_ENCRYPTION_KEY; do
		case " $secrets" in *" $k "*) ;; *) bad "$k is not classified as a minted secret" ;; esac
	done
	for k in ALETHIA_SANDBOX ALETHIA_DEPLOYMENT_MODE ALETHIA_LICENSE_ACTIVE ALETHIA_RUNNER_OPERATOR ALETHIA_EDITION; do
		case " $secrets" in *" $k "*) bad "$k is classified as a secret, so env:up would refuse it" ;; esac
	done

	# C6. env:status names an env whose .env lacks a key — through a stubbed box.
	box="$TMP/box"
	mkdir -p "$box/envs/stale" "$box/envs/fine" "$box/envs/pinned"
	legacy "$box/envs/stale/.env"
	dotenv_render_old >"$box/envs/fine/.env"
	# A pin written the way people hand-write one: quoted, CRLF — every dotenv loader reads `community`.
	dotenv_render_old | grep -v '^ALETHIA_EDITION=' >"$box/envs/pinned/.env"
	printf 'ALETHIA_EDITION="community"\r\n' >>"$box/envs/pinned/.env"
	cat >"$TMP/drive-gaps.sh" <<'SH'
set -euo pipefail
. "$1"
REMOTE="$2"
ssh_box() { case "$1" in *env-registry.sh*) echo '{"stale":{},"fine":{},"gone":{},"pinned":{}}' ;; *) sh -c "$1" ;; esac; }
env_dotenv_gaps
SH
	out="$(bash "$TMP/drive-gaps.sh" "$TMP/dotenv.sh" "$box" 2>&1)" || bad "env_dotenv_gaps failed: $out"
	printf '%s\n' "$out" | grep -qx 'stale missing:ALETHIA_SANDBOX,ALETHIA_LICENSE_ACTIVE,ALETHIA_EDITION unset' ||
		bad "env:status does not flag an env missing ALETHIA_SANDBOX and its edition pin: $out"
	printf '%s\n' "$out" | grep -qx 'fine ok enterprise' || bad "env:status flags a complete .env: $out"
	printf '%s\n' "$out" | grep -qx 'pinned ok community' || bad "env:status misreads a quoted CRLF community pin: $out"
	printf '%s\n' "$out" | grep -qx 'gone no-file no-file' || bad "env:status is silent about an env with no .env: $out"
	gaps="$out"

	# C7. The edition row: the PIN held against the MEASURED scope (#6158). Each pair that looks
	# fine alone and is a defect together must say MISMATCH; a `?` scope must not be compared.
	erow() { # <pin> <scope> <expected substring>
		local got
		got="$(bash -c '. "$1"; edition_row "$2" "$3"' _ "$TMP/dotenv.sh" "$1" "$2")"
		case "$got" in
		*"$3"*) ;;
		*) bad "edition_row '$1' '$2' → '$got', want '$3'" ;;
		esac
	}
	erow enterprise enterprise "enterprise (pinned, matches scope)"
	erow community community-pinned "community (pinned, matches scope)"
	erow community enterprise "MISMATCH pinned community, console serving enterprise"
	erow enterprise COMMUNITY "MISMATCH pinned enterprise, console serving community"
	erow enterprise community-pinned "MISMATCH pinned enterprise, console serving community"
	erow unset enterprise "UNPINNED (unset) — prod pins enterprise; run pnpm env:up"
	# A PRESENT auto line is never rewritten by env:up, so "run env:up" would be a remedy that does nothing.
	erow auto enterprise "UNPINNED (auto) — env:up never rewrites a present line"
	case "$(bash -c '. "$1"; edition_row auto enterprise' _ "$TMP/dotenv.sh")" in
	*"run pnpm env:up on that branch"*) bad "edition_row tells an env with a literal auto line to re-run env:up, which never rewrites it" ;;
	esac
	erow other enterprise "is not community, enterprise or auto"
	erow enterprise "?-no-answer" "not compared"
	erow no-file enterprise "?-no-.env"
	erow "" enterprise "?-not-checked"
	# …and joined to the right env through env_status's own plumbing.
	rows="$(bash -c '. "$1"; edition_rows "$2" "$3"' _ "$TMP/dotenv.sh" \
		"$(printf 'pinned enterprise\nfine enterprise\nstale ?-no-answer\n')" "$gaps")"
	printf '%s\n' "$rows" | grep -q "^pinned	⚠ MISMATCH pinned community, console serving enterprise" ||
		bad "env:status does not report a community pin served as enterprise: $rows"
	printf '%s\n' "$rows" | grep -q "^fine	enterprise (pinned, matches scope)" || bad "a matching env is not reported as matching: $rows"
	printf '%s\n' "$rows" | grep -q "^stale	⚠ UNPINNED (unset)" || bad "an unpinned env is not flagged: $rows"

	# C8. env:up --community on an env already pinned enterprise is REFUSED, not silently ignored.
	note() { bash -c 'die() { echo "DIED: $1"; exit 9; }; . "$1"; edition_pin_note s1 "$2" "$3"' _ "$TMP/dotenv.sh" "$1" "$2"; }
	rc=0
	out="$(note community enterprise 2>&1)" || rc=$?
	[ "$rc" = 9 ] || bad "env:up --community on an enterprise-pinned env did not refuse (rc $rc): $out"
	rc=0
	out="$(note enterprise community 2>&1)" || rc=$?
	[ "$rc" = 0 ] || bad "a default env:up refused a deliberately community-pinned env (rc $rc): $out"
	case "$out" in *"stays pinned ALETHIA_EDITION=community"*) ;; *) bad "keeping a community pin was silent: $out" ;; esac
	rc=0
	out="$(note enterprise enterprise 2>&1)" || rc=$?
	[ "$rc" = 0 ] && [ -z "$out" ] || bad "a matching pin was not silent (rc $rc): $out"


	# C9. ONE reading of the pin. env:status prints a `scope` row (env-mode.sh's scope_probe reads
	# the .env) and an `edition` row (dotenv_edition reads it); if the two parsers normalise
	# differently they disagree about the same line and MISMATCH reports the parsers, not the env.
	# scope_probe is driven for real with curl stubbed to 404, where its verdict turns on the pin.
	mode_sh="$ROOT/scripts/box/env-mode.sh"
	for f in scope_verdict scope_probe; do
		sed -n "/^$f() {/,/^}$/p" "$mode_sh" >>"$TMP/scope.sh"
		grep -q "^$f() {" "$TMP/scope.sh" || bad "could not lift $f() out of $mode_sh"
	done
	pv="$TMP/parity"
	mkdir -p "$pv"
	i=0
	for line in 'ALETHIA_EDITION=community' 'ALETHIA_EDITION="community"' "ALETHIA_EDITION='community'" \
		'ALETHIA_EDITION=  community  ' 'ALETHIA_EDITION=comm unity' 'ALETHIA_EDITION=enterprise' \
		'export ALETHIA_EDITION=community' 'ALETHIA_EDITION=' 'ALETHIA_EDITION="\x27community\x27"' \
		'# ALETHIA_EDITION=community' 'ALETHIA_EDITION=Community' 'ALETHIA_EDITION="community'; do
		i=$((i + 1))
		printf 'X=1\n%b\r\n' "$line" >"$pv/$i.env"
		pin="$(sh -c "$(bash -c '. "$1"; declare -f dotenv_edition' _ "$TMP/dotenv.sh"); dotenv_edition \"\$1\"" sh "$pv/$i.env")"
		verdict="$(bash -c 'curl() { printf 404; }; sleep() { :; }; . "$1"; scope_probe 1 "$2" 1 1' _ "$TMP/scope.sh" "$pv/$i.env")"
		verdict="${verdict%% *}"
		case "$pin:$verdict" in
		community:community | enterprise:DEFECT | unset:DEFECT | auto:DEFECT | other:DEFECT) ;;
		*) bad "the two pin readers disagree on '$line': dotenv_edition=$pin, scope_probe=$verdict" ;;
		esac
	done

	# C10. The CALL SITES, not just the parts: --community must reach the template, and the read-back
	# must run. Each of these is one deleted word away from an env:up that pins enterprise while
	# telling its caller it pinned community.
	for f in up_flags usage_error mint_env; do
		sed -n "/^$f() {/,/^}$/p" "$env_sh" >>"$TMP/callsites.sh"
		grep -q "^$f() {" "$TMP/callsites.sh" || bad "could not lift $f() out of $env_sh"
	done
	flags() { bash -c '. "$1"; shift; up_flags "$@"; echo "$UP_EDITION"' _ "$TMP/callsites.sh" "$@"; }
	[ "$(flags --community)" = community ] || bad "env:up --community does not set the community edition"
	[ "$(flags --fresh --community --seed)" = community ] || bad "--community is lost among other flags"
	[ "$(flags)" = enterprise ] || bad "a plain env:up does not default to enterprise"
	cat >"$TMP/drive-mint.sh" <<'SH'
set -euo pipefail
. "$1"; . "$2"
REMOTE=/opt/alethia
# Upper-case on purpose: mint_env declares `local pinned`, which would shadow a stub's variable.
MINT_LOG="$3"; REQUESTED="$4"; PIN_ANSWER="$5"
die() { echo "DIED: $1" >>"$MINT_LOG"; exit 9; }
openssl() { echo X; }
ed25519_raw_b64() { echo X; }
env_fqdn() { echo s1.example; }
ssh_box() {
	case "$1" in
	*dotenv_reconcile*) cat >>"$MINT_LOG"; return 0 ;;
	*dotenv_edition*) echo "$PIN_ANSWER"; return 0 ;;
	esac
}
mint_env s1 3100 8400 db_s1 "" "$REQUESTED"
echo DONE >>"$MINT_LOG"
SH
	ml="$TMP/mint.log"
	: >"$ml"
	bash "$TMP/drive-mint.sh" "$TMP/dotenv.sh" "$TMP/callsites.sh" "$ml" community community >/dev/null 2>&1 ||
		bad "mint_env --community failed against a community pin"
	grep -qx 'ALETHIA_EDITION=community' "$ml" || bad "mint_env did not hand --community to the template it ships"
	: >"$ml"
	rc=0
	bash "$TMP/drive-mint.sh" "$TMP/dotenv.sh" "$TMP/callsites.sh" "$ml" community enterprise >/dev/null 2>&1 || rc=$?
	[ "$rc" = 9 ] && grep -q '^DIED: .*already pinned' "$ml" ||
		bad "mint_env did not refuse --community on an enterprise-pinned env — is edition_pin_note still called? (rc $rc)"
	# cmd_up is not driven (it is all ssh); its two edition lines are pinned by text instead.
	up_body="$(sed -n '/^cmd_up() {/,/^}$/p' "$env_sh")"
	printf '%s\n' "$up_body" | grep -qx '  edition="\$UP_EDITION"' || bad "cmd_up does not read UP_EDITION"
	printf '%s\n' "$up_body" | grep -qx '  mint_env "\$slug_" "\$cport" "\$sport" "\$db" "\$fresh" "\$edition"' ||
		bad "cmd_up does not pass the edition to mint_env"

	# D. A DEFECT is described as the fault it IS (#6166). env-mode.sh gives a 404 (serving
	# community) and a 5xx under the enterprise pin (ee did not load; every auth call fails) the
	# same verdict word, and env.sh described both as COMMUNITY in four places. Each place is
	# driven here for BOTH statuses, with only ssh_box stubbed — the probe's answer is the input.
	d_before="$fails"
	for f in scope_defect_label scope_headline scope_remedy measure_scope env_scopes cmd_test \
		restart_env_console restore_live_envs; do
		sed -n "/^$f() {/,/^}$/p" "$env_sh" >>"$TMP/defect.sh"
		grep -q "^$f() {" "$TMP/defect.sh" || bad "could not lift $f() out of $env_sh"
	done
	d404='DEFECT 404 the organization plugin is absent'
	d500='DEFECT 500 ALETHIA_EDITION=enterprise is pinned but the enterprise module did not load'

	# D1. env_scopes — its probe body runs ON THE BOX as text, so it is run here under `sh`, against
	# a fixture env-mode.sh that answers per port with the line the real probe prints.
	sbox="$TMP/scopebox"
	mkdir -p "$sbox/bin"
	cat >"$sbox/bin/env-mode.sh" <<SH
#!/bin/sh
# scope_probe — present, so env_scopes asks it rather than reporting a stale script.
case "\$2" in
3101) echo "$d404" ;;
3102) echo "$d500" ;;
*) echo "enterprise 422 the organization plugin is registered" ;;
esac
SH
	chmod +x "$sbox/bin/env-mode.sh"
	cat >"$TMP/drive-scopes.sh" <<'SH'
set -euo pipefail
. "$1"
REMOTE="$2"
ssh_box() { case "$1" in *env-registry.sh*) echo '{"c":{"consolePort":3101},"e":{"consolePort":3102},"ok":{"consolePort":3103}}' ;; *) sh -c "$1" ;; esac; }
env_scopes
SH
	out="$(bash "$TMP/drive-scopes.sh" "$TMP/defect.sh" "$sbox" 2>&1)" || bad "env_scopes failed: $out"
	printf '%s\n' "$out" | grep -qx 'c COMMUNITY' || bad "env:status does not label a 404 DEFECT COMMUNITY: $out"
	printf '%s\n' "$out" | grep -qx 'e EE-NOT-LOADED' || bad "env:status labels a pinned-enterprise 5xx DEFECT as something else: $out"
	printf '%s\n' "$out" | grep -qx 'ok enterprise' || bad "env:status mislabels an enterprise console: $out"
	# …and the edition row it feeds does not call that measured scope "not measured".
	erow enterprise EE-NOT-LOADED "pinned enterprise, but the console cannot load the enterprise edition"

	# D2. env:test's refusal: both DEFECTs are refused (die), each in its own words.
	cat >"$TMP/drive-test.sh" <<'SH'
. "$1"
REMOTE=/opt/alethia; ANSWER="$2"
need() { :; }; slug() { echo s1; }; env_fqdn() { echo s1.example; }; push_tree() { :; }; build_ee() { :; }
die() { echo "DIED: $1"; exit 9; }
ssh_box() { case "$1" in *env-registry.sh*) echo '{"s1":{"consolePort":3101}}' ;; *--scope*) echo "$ANSWER" ;; *) echo "UNEXPECTED: $1"; return 1 ;; esac; }
cmd_test
echo "NOT-REFUSED"
SH
	t404="$(bash "$TMP/drive-test.sh" "$TMP/defect.sh" "$d404" 2>&1)"
	case "$t404" in
	*"DIED: 's1' is serving COMMUNITY entitlements — the organization plugin is absent"*"upgrade_required"*"pnpm env:up"*) ;;
	*) bad "env:test does not refuse a 404 DEFECT as COMMUNITY: $t404" ;;
	esac
	t500="$(bash "$TMP/drive-test.sh" "$TMP/defect.sh" "$d500" 2>&1)"
	case "$t500" in
	*COMMUNITY* | *upgrade_required* | *NOT-REFUSED*) bad "env:test describes a pinned-enterprise 5xx as COMMUNITY, or does not refuse it: $t500" ;;
	*"DIED: 's1' cannot load the enterprise edition its .env pins"*"answers 500"*"pnpm env:logs"*) ;;
	*) bad "env:test does not name the enterprise load failure for a 5xx DEFECT: $t500" ;;
	esac

	# D3. The restart after a run, and the restore after a reboot: exit 3 is "up, in the wrong
	# scope" for BOTH, so the line under it must ask which.
	cat >"$TMP/drive-restart.sh" <<'SH'
. "$1"
REMOTE=/opt/alethia; ANSWER="$2"
env_rss_mb() { echo 100; }
ssh_box() {
	case "$1" in
	*env-registry.sh*) echo '{"s1":{"consolePort":3101,"storagePort":8400,"database":"db_s1"}}' ;;
	*has-session*) return 1 ;;
	*--scope*) echo "$ANSWER" ;;
	*keep*) echo "boot output"; return 3 ;;
	*) return 0 ;;
	esac
}
restart_env_console s1
echo "=== restore"
restore_live_envs
SH
	r404="$(bash "$TMP/drive-restart.sh" "$TMP/defect.sh" "$d404" 2>&1)"
	r500="$(bash "$TMP/drive-restart.sh" "$TMP/defect.sh" "$d500" 2>&1)"
	case "$r404" in
	*"the console is back, but it is serving COMMUNITY entitlements"*"=== restore"*"s1 is back, but it is serving COMMUNITY entitlements"*"must run: pnpm env:up"*) ;;
	*) bad "restart/restore do not report a 404 DEFECT as COMMUNITY: $r404" ;;
	esac
	case "$r500" in
	*COMMUNITY*) bad "restart/restore describe a pinned-enterprise 5xx as COMMUNITY: $r500" ;;
	*"the console is back, but it cannot load the enterprise edition"*"pnpm env:logs"*"=== restore"*"s1 is back, but it cannot load the enterprise edition"*"must run: pnpm env:logs"*) ;;
	*) bad "restart/restore do not name the enterprise load failure for a 5xx DEFECT: $r500" ;;
	esac
	[ "$fails" = "$d_before" ] &&
		ok "a 404 DEFECT reads COMMUNITY and a pinned-enterprise 5xx DEFECT reads EE-NOT-LOADED in env:test, env:status, the restart and the restore — and both are still refused"

	[ "$fails" = "$before" ] &&
		ok "an existing .env gains the keys it predates, keeps every value it has, refuses a missing secret without --fresh, and env:status names the gap"
	[ "$fails" = "$before" ] &&
		ok "every env pins ALETHIA_EDITION (enterprise, or community when asked), a pin is never overridden, and env:status reports a pin the console is not serving"

	[ "$fails" = 0 ] || echo "functions($env_sh): $fails failed" >&2
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

echo "# 7b: env.sh's status contracts"
bash "$SELF" --functions "$ENV_SH" || fails=$((fails + 1))

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
# A MUTANT MUST STILL PARSE. One of these was written badly enough to delete an unrelated `fi` in
# cmd_up, and it was duly "caught" — by `bash -n` failing inside the probe, which says nothing
# about the assertion it was supposed to exercise. A mutation that breaks the file is not a
# mutation, it is a typo with a green tick.
mutate_env() { # <name> — reads the program from stdin, applied by awk
	local out="$TMP/env-$1.sh"
	awk -f /dev/stdin "$ENV_SH" >"$out"
	cmp -s "$ENV_SH" "$out" && {
		bad "mutation '$1' changed nothing — it is not testing what it names"
		return
	}
	bash -n "$out" 2>/dev/null || {
		bad "mutation '$1' does not parse — it would be 'caught' for the wrong reason"
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
mutate_lib prefix-exported-as-the-tag-name "s/tag='\\\$_suite_tag' base=/export ALETHIA_SUITE_TAG='\\\$_suite_tag'; tag='\\\$_suite_tag' base=/"

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

# The variable hoist: every mention still reads in an acceptable order while the box runs the
# install INSIDE the tagged region. This is what defeated a line-number comparison, and it is the
# reason the checks above are byte offsets plus a mention count.
mutate_env installs-hoisted-into-a-variable <<'AWK'
/^  suite_arm "\$slug_"$/ { print "  local warm=\"pnpm install --frozen-lockfile >/dev/null\"" }
{ sub(/pnpm install --frozen-lockfile >\/dev\/null/, "$warm"); print }
AWK

# A SECOND tag-exporting run, added after suite_disarm: unarmed for its whole life, which is
# exactly the defect this section exists for, and invisible to a guard that locates one run.
mutate_env a-second-unarmed-run <<'AWK'
{ print }
/^  suite_disarm$/ && !seen { seen = 1; print "  ssh_box \"export ALETHIA_SUITE_TAG=\047$_suite_tag\047 && echo late\"" }
AWK

# The tag exported with a value that is not the run's: fail-safe (the reap matches nothing and
# degrades to report-only) and completely silent, so the anchor is the whole assignment.
mutate_env tag-exported-with-the-wrong-value <<'AWK'
{ sub(/export ALETHIA_SUITE_TAG='\$_suite_tag'/, "export ALETHIA_SUITE_TAG=\047hello\047"); print }
AWK

# The two status contracts, mutated back to the forms that shipped. `mutate_env` probes the call
# sites; these need the --functions probe, which is what actually drives them.
mutate_fn() { # <name> — awk program on stdin
	local out="$TMP/fn-$1.sh"
	awk -f /dev/stdin "$ENV_SH" >"$out"
	cmp -s "$ENV_SH" "$out" && {
		bad "mutation '$1' changed nothing — it is not testing what it names"
		return
	}
	bash -n "$out" 2>/dev/null || {
		bad "mutation '$1' does not parse — it would be 'caught' for the wrong reason"
		return
	}
	detect --functions "$1" "$out"
}

# push_tree ending on `ssh_box … || echo …` — always 0, so nothing decides its status, the rsync
# included. Under `--watch` that fed build_ee a stale tree and printed "pushed" indefinitely.
# SCOPED TO push_tree by a range, not by proximity to the touch: cmd_up runs a registry touch of
# its own, and a looser rule deleted an `fi` out of THAT function instead.
mutate_fn push-status-swallowed-by-the-touch <<'AWK'
/^push_tree\(\) \{/ { inside = 1 }
inside && /^  return "\$rsync_rc"$/ { next }
inside && /^  if \[ "\$rsync_rc" = 0 \]; then$/ { next }
inside && /^  fi$/ { next }
{ print }
inside && /^\}$/ { inside = 0 }
AWK

# #6110, both halves and the over-reach. The static list gone (the rule would still cover the
# fixture, so only the source check can see it); the rule gone (a new `.cache/` ships again); and
# the rule widened to every untracked top-level directory, which withholds new source.
mutate_fn static-junk-excludes-dropped <<'AWK'
/^    --exclude=\/\.pnpm-store --exclude=\/\.codex-run-base$/ { next }
{ print }
AWK
mutate_fn dot-dir-rule-dropped <<'AWK'
/^    excludes\+=\("--exclude=\/\$entry"\)$/ { next }
{ print }
AWK
mutate_fn rule-widened-to-every-untracked-dir <<'AWK'
{ sub(/^      \.\*\/\) entry=/, "      */) entry="); print }
AWK

# ssh_box exiting instead of returning: `|| true` can never catch it, and inside `$( )` the
# containment turns a CAUGHT failure into an uncaught assignment status that errexit acts on.
mutate_fn ssh-box-exits-instead-of-returning <<'AWK'
{ sub(/ip="\$\(require_box\)" \|\| return \$\?/, "ip=\"$(require_box)\" || exit $?"); print }
AWK

# #6111, the defect verbatim and its two nearest misses. Write-once restored (an existing .env is
# left alone); a missing secret minted into a live env; and env:status reporting every env as ok.
mutate_fn dotenv-write-once-again <<'AWK'
/^dotenv_reconcile\(\) \{/ { inside = 1 }
{ print }
inside && /^  _new="\$\(cat\)"$/ { print "  return 0"; inside = 0 }
AWK
mutate_fn dotenv-secret-minted-into-a-live-env <<'AWK'
{ sub(/^      \[ "\$_s" = "\$_k" \] && _is_secret=1$/, "      :"); print }
AWK
mutate_fn status-never-reports-a-gap <<'AWK'
{ sub(/\|\| m="\$m\$\{m:\+,\}\$k"$/, "|| :"); print }
AWK

# #6158: the pin dropped from the template (every env runs auto again); a pin read back as unset
# whatever it says; the mismatch never reported; and --community silently ignored on a pinned env.
mutate_fn edition-pin-dropped-from-template <<'AWK'
/^ALETHIA_EDITION=\$edition$/ { next }
{ print }
AWK
mutate_fn edition-never-read-back <<'AWK'
{ sub(/^  enterprise \| community \| auto\) echo "\$_e" ;;$/, "  enterprise | community | auto) echo unset ;;"); print }
AWK
mutate_fn edition-mismatch-never-reported <<'AWK'
{ sub(/^  if \[ "\$pin" = "\$served" \]; then$/, "  if :; then"); print }
AWK
# The call sites (A3 on #6160): --community parsed as enterprise; mint_env rendering without it;
# the read-back dropped; cmd_up not passing it on.
mutate_fn community-flag-parsed-as-enterprise <<'AWK'
{ sub(/^    --community\) edition="community" ;;$/, "    --community) edition=\"enterprise\" ;;"); print }
AWK
mutate_fn mint-renders-without-the-edition <<'AWK'
{ sub(/"\$snapshot_key" "\$bootstrap_token" "\$edition" \|$/, "\"$snapshot_key\" \"$bootstrap_token\" |"); print }
AWK
mutate_fn pin-note-never-called <<'AWK'
/^  edition_pin_note "\$slug_" "\$edition" "\$pinned"$/ { next }
{ print }
AWK
mutate_fn cmd-up-drops-the-edition <<'AWK'
{ sub(/"\$db" "\$fresh" "\$edition"$/, "\"$db\" \"$fresh\""); print }
AWK
mutate_fn pin-reader-strips-inner-spaces <<'AWK'
{ sub(/tr -d '\\r' \|$/, "tr -d '\\r ' |"); print }
AWK
mutate_fn community-request-silently-ignored <<'AWK'
/^edition_pin_note\(\) \{/ { inside = 1 }
inside && /^  if \[ "\$requested" = community \]; then$/ { sub(/community/, "nobody") }
{ print }
inside && /^\}$/ { inside = 0 }
AWK

# #6166: each site that described a pinned-enterprise 5xx DEFECT as COMMUNITY, put back the way it
# shipped — plus the shared label collapsing to one word, and the remedy losing the log.
mutate_fn status-labels-every-defect-community <<'AWK'
{ sub(/^    DEFECT\)     echo "\$s \$\(scope_defect_label "\$\{2:-\}"\)" ;;$/, "    DEFECT)     echo \"$s COMMUNITY\" ;;"); print }
AWK
mutate_fn defect-label-ignores-the-status <<'AWK'
/^  5\[0-9\]\[0-9\]\) echo EE-NOT-LOADED ;;$/ { next }
{ print }
AWK
mutate_fn env-test-refuses-a-5xx-in-community-words <<'AWK'
/^cmd_test\(\) \{/ { inside = 1 }
inside && /^    EE-NOT-LOADED\)$/ { sub(/EE-NOT-LOADED/, "EE-NEVER") }
{ print }
inside && /^\}$/ { inside = 0 }
AWK
mutate_fn restore-says-community-again <<'AWK'
{ sub(/is back, but it \$\(scope_headline "\$scope_"\) \(see above\)/, "is back but serving COMMUNITY entitlements (see above)"); print }
AWK
mutate_fn restart-says-community-again <<'AWK'
{ sub(/the console is back, but it \$\(scope_headline "\$scope_"\)\./, "the console is back, but it came up serving COMMUNITY entitlements."); print }
AWK
mutate_fn edition-row-calls-ee-not-loaded-unmeasured <<'AWK'
/^  EE-NOT-LOADED\) echo "⚠ pinned/ { next }
{ print }
AWK
mutate_fn remedy-drops-the-log <<'AWK'
/^  DEFECT:EE-NOT-LOADED\) echo "pnpm env:logs/ { next }
{ print }
AWK

# ── 9. and it must NOT fire on a legal reflow ─────────────────────────────────────────────────
# A guard that reds on correct code is one somebody deletes. Collapsing the backslash
# continuations puts `ssh_box "`, `pnpm install` and the export on ONE line — same command, same
# order, no line numbers left to compare — which is precisely the case a line-based check reported
# as "no ssh_box invocation carries the tag export".
echo "# 9: a legal reflow must stay green"
awk '{ if (sub(/\\$/, "")) { printf "%s", $0 } else { print } }' "$ENV_SH" >"$TMP/env-reflowed.sh"
if ! cmp -s "$ENV_SH" "$TMP/env-reflowed.sh" && bash -n "$TMP/env-reflowed.sh" 2>/dev/null; then
	if bash "$SELF" --callsites "$TMP/env-reflowed.sh" >/dev/null 2>&1; then
		ok "a single-line && chain still reads as arm → install → tag → run → disarm"
	else
		bad "the call-site guard reds on a legal reflow — it is measuring layout, not order"
	fi
else
	bad "the reflow fixture did not produce a different, parseable env.sh"
fi

if [ "$fails" = 0 ]; then
	echo "env suite-reap: all passed"
else
	echo "env suite-reap: $fails failed" >&2
fi
exit "$fails"
