#!/usr/bin/env bash
# shellcheck shell=bash
#
# A remote suite must not outlive the local command that started it (#4343).
#
# `ssh_box` opens no pty (no `-t`), so nothing on the box is ever signalled: kill or supersede the
# local `pnpm env:check` and sshd's child chain dies while the vitest workers reparent to PID 1 and
# keep running at ~30% CPU and ~2.7 GB each, indefinitely. Three per abandoned run. #4343 found one
# set that had been running 8h40m on the SHARED 15 GB box, which was at load 100 with 0 GB
# available — and the visible symptom was an UNRELATED lane failing with
# `[vitest-worker]: Timeout calling "fetch" with ".../config-fields.tsx"`: pure contention,
# reported as a red test file on a branch that had nothing to do with it.
#
# Nothing on the box reaps them, so every abandoned run permanently subtracts capacity. So the
# local side signals the remote side itself, on the way out.
#
# THE SCOPE IS A TAG IN THE ENVIRONMENT, and that choice is the whole safety argument. The box is
# shared: killing another instance's suite would be a worse defect than the one this fixes. Every
# process the tagged part of the run spawns inherits ALETHIA_SUITE_TAG — a value unique to THIS
# invocation — and /proc/<pid>/environ is where the reap reads it back.
#
# NOT `pkill -f "envs/$slug"`, which is the manual remedy the issue names and is the right
# instrument for a HUMAN who has looked at `ps` first. Unattended it cannot tell this run's vitest
# from the env's OWN console, its tmux session or a concurrent `env:push` — all under
# `$REMOTE/envs/<slug>` — so a Ctrl-C on a check could take the running environment down with it.
#
# The invariant is "only what this run started", NOT "never a console". apps/console/playwright.
# config.ts sets `reuseExistingServer: !isCI` and cmd_test unsets CI, so when nothing is already
# serving, Playwright starts `pnpm dev` ITSELF and that server is a tagged child. Reaping it is
# right — the run brought it up and nothing else is using it — but a reader reasoning from "the
# console can never be tagged" would be reasoning from something this does not promise.
#
# WHAT THE CALLER MUST NOT TAG. The tag is inherited, so everything after the `export` is in the
# blast radius, and the caller decides where that starts. Anything whose state is BOX-GLOBAL must
# be left outside it: `playwright install --with-deps` runs apt/dpkg as root, and TERM-then-KILL
# mid-transaction leaves the package database interrupted for every other env and engineer on the
# box — this defect through a different door. `pnpm install` is outside for the weaker version of
# the same reason. Both call sites in scripts/env.sh export the tag AFTER their install steps, and
# scripts/lib/env-suite-reap-test.sh asserts that ordering against env.sh's source.
#
# The `export` lands the tag in the environ of the run's CHILDREN, not of the remote bash that
# drives them, because /proc/<pid>/environ is the copy taken at exec time and an export after that
# does not rewrite it. That is the right set: the observed orphans are the deep node processes,
# whose parents DID die with the connection (that is what a ppid of 1 means). In the rarer case
# where the driver survives too, killing its children breaks the `&&` chain and it exits.
#
# WHAT THIS CANNOT COVER: SIGKILL, a dropped link, a closed laptop. A trap cannot run in a process
# that was never signalled, and no amount of care here changes that. Catching those needs #4343's
# option (3), a reaper ON the box, which is deliberately not built.
#
# DEPENDS ON `ssh_box` and `$REMOTE` from scripts/env.sh, resolved when a reap actually runs. That
# is what lets the test drive these functions with a stub and no box.

_suite_tag=""
_suite_slug=""
_suite_live=0

# The reap, as the remote shell runs it. Single-quoted so NOTHING in it expands locally; `tag` and
# `dir` are supplied as plain assignments in front of it by suite_reap.
#
# `tagged` is a function because it is asked TWICE. The KILL sweep targets pids collected before
# the TERM, and a pid is the one thing in here that is not the tag — so "the box is clear of this
# run" is re-measured against the tag rather than asserted from the earlier snapshot.
#
# The failure branch is the interesting one. A tagged reap names only this run, so "nothing
# matched" is an ordinary outcome — but it is also what a tag that failed to propagate looks like,
# and the two are indistinguishable from here. So when nothing matched, REPORT what is still under
# this env's tree instead of killing it: that is the operator's evidence, in the shape the issue's
# own detection snippet prints, and the one case where a human should reach for the scoped pkill.
#
# `2>/dev/null` precedes the input redirection deliberately: redirections apply left to right, so
# with it after `< "$d/environ"` the "no such file" for a process that exited between the glob and
# the read goes to the ORIGINAL stderr and lands in the middle of the report.
# shellcheck disable=SC2016  # the point: this expands on the BOX, not here.
_SUITE_REAP_SH='
tagged() {
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    # Cannot fire today: `tag` and `dir` are plain assignments, ssh forwards no environment, so
    # this shell does not carry the tag it is matching. It is here so that adding an `export`
    # cannot quietly make the reaper its own first victim.
    [ "$p" = "$$" ] && continue
    tr 2>/dev/null "\0" "\n" < "$d/environ" | grep -Fqx "ALETHIA_SUITE_TAG=$tag" || continue
    printf " %s" "$p"
  done
}
pids=$(tagged)
if [ -n "$pids" ]; then
  echo "  signalling:$pids"
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  sleep 2
  for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
  still=$(tagged)
  if [ -z "$still" ]; then
    echo "  the box is clear of this run."
  else
    echo "  ⚠ still carrying this run tag after TERM and KILL:$still"
  fi
else
  echo "  nothing carrying this run tag is still running."
  left=$(pgrep -af "$dir" 2>/dev/null | grep -v "^$$ " || true)
  if [ -n "$left" ]; then
    echo "  ⚠ but these are still running under $dir — NOT killed, because a tagged reap"
    echo "    names only its own run and one of these may be the environment itself:"
    echo "$left" | sed "s/^/      /"
  fi
fi
'

# Arm the trap around ONE remote run. The caller must put $_suite_tag into the remote command's
# environment, after anything whose state is box-global; nothing else scopes the reap.
suite_arm() { # <slug>
	_suite_slug="$1"
	_suite_tag="alethia-suite-$1-$$-$(date -u +%s)"
	_suite_live=1
	# THE INT TRAP IS LOAD-BEARING, and the reason is narrower than it looks. Bash does not die
	# of an unhandled SIGINT delivered to the SCRIPT ALONE while it waits on a foreground child
	# that was not itself signalled: it abandons the wait and CONTINUES. In the cmd_check shape
	# that means it reaches suite_disarm before the EXIT trap ever runs, so the reap never fires
	# and an interrupted check returns 0 — measured, and it is exactly the case #4343 is about.
	# (An earlier revision of this comment claimed the EXIT trap alone covered it. It does cover
	# TERM, and INT delivered to the whole process group; it does not cover that one, which is
	# the one a supervisor sending a signal to one pid produces.)
	#
	# `|| true` on the reap is not decoration either: suite_reap returns the status it was
	# entered with, which on a group Ctrl-C is 130, and `set -e` would abort the handler right
	# there — leaving the re-raise below as dead code and the shell exiting 130 by errexit
	# instead of dying of the signal it was sent.
	trap 'suite_reap || true; trap - INT; kill -INT $$' INT
	trap 'suite_reap || true; trap - TERM; kill -TERM $$' TERM
	trap 'suite_reap' EXIT
}

# The run ENDED — passed or failed, but on its own terms. Its processes are gone, so a reap now
# would be a live round-trip that could only find something that is not ours.
suite_disarm() {
	_suite_live=0
	trap - INT TERM EXIT
}

suite_reap() {
	local rc=$?
	[ "$_suite_live" = 1 ] || return "$rc"
	_suite_live=0
	echo "" >&2
	echo "→ stopping this run on the box — a remote suite does NOT die with this shell." >&2
	# A SUBSHELL, and `|| true`. require_box calls `exit 1` when the box or its state cannot be
	# read, and `set -e` ends the script on a failed ssh; from inside an EXIT trap either one
	# would replace the run's real exit code with this cleanup's. Cleanup never speaks for a run.
	#
	# `dir` carries its trailing slash INTO the assignment, so this command line matches the
	# `pgrep -af "$dir"` above and the self-filter it feeds is a live rule rather than a comment.
	(ssh_box "tag='$_suite_tag' dir='$REMOTE/envs/$_suite_slug/'; $_SUITE_REAP_SH") >&2 || true
	return "$rc"
}
