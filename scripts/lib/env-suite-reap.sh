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

# The reap, as the remote shell runs it. Single-quoted so NOTHING in it expands locally; `tag`,
# `base` and `slug` are supplied as plain assignments in front of it by suite_reap.
#
# THE ENV PATH IS ASSEMBLED HERE, from `base` and `slug`, and never passed whole. `pgrep -af
# "$dir"` searches command lines, and this reap IS a command line: hand it `dir='/opt/alethia/
# envs/l6-cards/'` and the pattern matches the reaper itself. A `$$` filter does not save it,
# because the command substitution around pgrep FORKS — the child has an identical
# /proc/<pid>/cmdline and a different pid — so the evidence block would name the reaper's own
# shell as a suspect in the one branch whose entire purpose is to hand an operator a trustworthy
# list. Assembling the path means the string the pattern looks for exists nowhere but in the
# processes it is asking about, and no filter is needed. Asserted against the composed command in
# scripts/lib/env-suite-reap-test.sh.
#
# `tagged` is a function because it is asked THREE times, and every one of them is the tag rather
# than a pid: a pid is a name for whatever occupies that slot NOW, and two seconds is long enough
# on a busy box for it to name something else. So the KILL sweep re-derives instead of reusing the
# TERM list, and "the box is clear of this run" is a fresh measurement rather than a claim about a
# snapshot taken before any signal was sent.
#
# The failure branch is the interesting one. A tagged reap names only this run, so "nothing
# matched" is an ordinary outcome — but it is also what a tag that failed to propagate looks like,
# and the two are indistinguishable from here. So when nothing matched, report what is still under
# this env's tree instead of killing it: the operator's evidence, in the shape the issue's own
# detection snippet prints, and the one case where a human should reach for the scoped pkill.
#
# IT REPORTS WHAT CARRIES THE PATH IN ITS ARGV, which is not the same as "everything under the
# tree" and must not be read as it. `pgrep -af` matches command lines, and a Next server's argv is
# literally `next-server (v16.2.12)` with no path in it — the same fact env_rss_mb in scripts/env.sh
# is built on, which is why THAT function resolves /proc/<pid>/cwd instead. So a running console
# never appears here. The class #4343 measured does: those vitest workers are `node
# …/envs/<slug>/node_modules/…`, path and all. A quiet report is therefore weaker evidence than a
# loud one, and `ps -eo pid,ppid,etime,args` on the box remains the complete answer.
#
# `2>/dev/null` precedes the input redirection deliberately: redirections apply left to right, so
# with it after `< "$d/environ"` the "no such file" for a process that exited between the glob and
# the read goes to the ORIGINAL stderr and lands in the middle of the report.
#
# NO `$$` SKIP in the loop, and the reason is narrower than "the prefix is unexported". What keeps
# the reaper out of its own results is that the prefix variables are named `tag`, `base` and
# `slug` — never ALETHIA_SUITE_TAG — and that ssh forwards no environment, so this shell cannot
# inherit the suite's. Exporting them would not be enough to break it either: the match is
# whole-line (`grep -Fqx "ALETHIA_SUITE_TAG=$tag"`), and an exported `tag=<value>` is a different
# line entirely.
#
# The edit that WOULD break it is a NAMED one — export a prefix variable as ALETHIA_SUITE_TAG.
# Then the `tr` and `grep` this loop execs carry the tag in their own environ, `still=$(tagged)`
# can never come back empty, and the reap reports as a survivor the reflection of itself. A `$$`
# comparison never covered that case: those helpers are not this shell. The test asserts the
# prefix's NAMES instead, which is the thing that actually holds.
# shellcheck disable=SC2016  # the point: this expands on the BOX, not here.
_SUITE_REAP_SH='
dir="$base/envs/$slug/"
tagged() {
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    tr 2>/dev/null "\0" "\n" < "$d/environ" | grep -Fqx "ALETHIA_SUITE_TAG=$tag" || continue
    printf " %s" "$p"
  done
}
pids=$(tagged)
if [ -n "$pids" ]; then
  echo "  signalling:$pids"
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  sleep 2
  for p in $(tagged); do kill -KILL "$p" 2>/dev/null || true; done
  sleep 1
  still=$(tagged)
  if [ -z "$still" ]; then
    echo "  the box is clear of this run."
  else
    echo "  ⚠ still carrying this run tag after TERM and KILL:$still"
  fi
else
  echo "  nothing carrying this run tag is still running."
  left=$(pgrep -af "$dir" 2>/dev/null || true)
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
	# $$ ALONE IS NOT UNIQUE ENOUGH TO SAY "this invocation". The box is shared between machines,
	# and pids are per-machine: two laptops running the same branch's check can land on the same
	# (slug, pid, second) and each reap the other's workers. $RANDOM is per-shell-seeded, so the
	# triple plus it is what makes the word in the comment above true.
	_suite_tag="alethia-suite-$1-$$-$(date -u +%s)-$RANDOM$RANDOM"
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
	# `base` and `slug` SEPARATELY, never the joined path: the reap assembles it remotely so that
	# the string `pgrep` searches for cannot appear in the reaper's own command line. See the
	# comment on _SUITE_REAP_SH.
	(ssh_box "tag='$_suite_tag' base='$REMOTE' slug='$_suite_slug'; $_SUITE_REAP_SH") >&2 || true
	return "$rc"
}
