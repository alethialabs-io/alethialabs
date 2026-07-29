#!/usr/bin/env bash
# SessionStart hook: a short Runtime block, so a session knows where the app runs
# before it tries to run it.
#
# The whole point is that a new session finds the right path from this banner and the
# `dev` skill alone, with no prompting — the failure this replaces is a session
# rediscovering how to run the project by colliding with it.
#
# TWO HARD RULES, both learned the expensive way:
#   1. NEVER BLOCK A SESSION. Every command is timeout-wrapped and every failure is
#      swallowed. This shells out to hcloud/ssh, which can hang on a dead network;
#      a session that will not start because a status banner is waiting on DNS is a
#      far worse bug than a missing banner.
#   2. Always exit 0.
set -u

say() { printf '%s\n' "$1"; }

# `timeout` is GNU; macOS has it only via coreutils. Degrade to running bare rather
# than skipping the whole banner — but keep every call cheap and local-only.
if command -v timeout >/dev/null 2>&1; then
	TO() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
	TO() { gtimeout "$@"; }
else
	TO() {
		shift
		"$@"
	}
fi

# $ROOT had to be two things at once and could only ever be one, so one of the lines
# below was always wrong: the branch line needs the SESSION's directory, while the box
# probe needs the MAIN CHECKOUT (state is gitignored and lives only there).
#
# The hook payload carries the session's cwd, so take the branch from that and leave
# MAIN_CHECKOUT (computed below) to answer everything about the box.
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
_payload="$(cat 2>/dev/null || true)"
SESSION_CWD="$ROOT"
if command -v jq >/dev/null 2>&1 && [ -n "$_payload" ]; then
	_cwd="$(printf '%s' "$_payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
	[ -n "$_cwd" ] && [ -d "$_cwd" ] && SESSION_CWD="$_cwd"
fi
say ""
say "── Runtime ─────────────────────────────────────────────────"

# ── Is the harness you are running the CURRENT one? ───────────────────────────────
#
# THE MOST IMPORTANT LINE THIS HOOK PRINTS, and the least obvious.
#
# Hooks resolve through $CLAUDE_PROJECT_DIR, so the copies that actually gate every tool
# call are the MAIN CHECKOUT's — even for a session working inside a worktree. The main
# checkout is pinned to `dev` but is NOT auto-pulled, so it silently falls behind, and the
# session then enforces an old ruleset and reads an old CLAUDE.md.
#
# This is not hypothetical. On 2026-07-27 the main checkout was 30+ commits behind: it was
# missing guard-runtime.sh and this very file entirely, so neither ran. A fix to a guard
# could not take effect for the session that wrote it, and the stale guard kept blocking
# edits that the fixed one allowed. Two PRs' worth of doc drift had the same root cause.
#
# Read-only and timeout-wrapped: `git fetch` touches the network but writes nothing to the
# working tree, and a failure here is silent by design.
GIT_COMMON="$(TO 3 git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
MAIN_CHECKOUT="$ROOT"
if [ -n "$GIT_COMMON" ]; then
	# In a linked worktree the common dir is the MAIN checkout's .git — its parent is the
	# main checkout, which is the tree whose .claude/ is actually in force.
	case "$GIT_COMMON" in
	*/.git) MAIN_CHECKOUT="$(cd "$(dirname "$GIT_COMMON")" 2>/dev/null && pwd || echo "$ROOT")" ;;
	esac
fi

TO 8 git -C "$MAIN_CHECKOUT" fetch -q origin dev >/dev/null 2>&1 || true
behind="$(TO 3 git -C "$MAIN_CHECKOUT" rev-list --count HEAD..origin/dev 2>/dev/null || echo 0)"
case "$behind" in '' | *[!0-9]*) behind=0 ;; esac

if [ "$behind" -gt 0 ]; then
	say ""
	say "  ⚠ STALE HARNESS — the main checkout is ${behind} commit(s) behind origin/dev."
	say "    Hooks and CLAUDE.md load from there, NOT from your worktree, so the rules"
	say "    gating this session are the old ones. Fix before trusting any guard:"
	say "      git -C ${MAIN_CHECKOUT} pull --ff-only"
	say ""
fi

# Where does this worktree's app run?
branch="$(TO 3 git -C "$SESSION_CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
slug="${branch#feat/}"
slug="${slug#fix/}"
slug="$(printf '%s' "$slug" | tr '[:upper:]/_' '[:lower:]--' | tr -cd 'a-z0-9-' | cut -c1-40)"
say "  branch    ${branch}   →   env '${slug:-dev}'"

# Box state. `tofu output` is local (reads state, no network); hcloud is not, hence
# the tight timeout. If either is unavailable we simply say less.
ip=""
if command -v tofu >/dev/null 2>&1; then
	# Must look like an IPv4, not merely be non-empty: with no state, `tofu output`
	# prints "Warning: No outputs found" on STDOUT, so a bare -n test reports a box
	# that does not exist. Same family as the repo's `""` vs unset trap — validate the
	# shape, never just the emptiness.
	# MAIN_CHECKOUT, not $ROOT: state is gitignored, so a worktree has none and this
	# printed "box down or not created" to EVERY worktree session while the box was up —
	# the first fact an instance learned about the runtime was false, and the remedy it
	# offered (pnpm env:box) would have built a second box.
	ip="$(TO 5 tofu -chdir="$MAIN_CHECKOUT/infra/sandbox" output -raw server_ipv4 2>/dev/null |
		grep -Eo '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || true)"
fi
if [ -n "$ip" ]; then
	# Envs in use / cap, and this branch's URL if it already holds a slot. An instance
	# needs both BEFORE it decides to take one: the box is shared, nothing is evicted
	# automatically, and `dev` permanently holds a slot as the integration env.
	slug="$(printf '%s' "${branch#feat/}" | sed 's|^fix/||' | tr '[:upper:]/_' '[:lower:]--' | tr -cd 'a-z0-9-' | cut -c1-40)"
	cap="$(TO 3 grep -oE 'env_cap[^0-9]+([0-9]+)' "$MAIN_CHECKOUT/infra/sandbox/terraform.tfvars" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
	reg="$(TO 6 ssh -o BatchMode=yes -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new \
		"root@$ip" 'cat /opt/alethia/envs.json' 2>/dev/null || true)"
	used=""
	mine=""
	if [ -n "$reg" ] && command -v jq >/dev/null 2>&1; then
		used="$(printf '%s' "$reg" | jq -r 'length' 2>/dev/null || true)"
		mine="$(printf '%s' "$reg" | jq -r --arg s "$slug" 'if has($s) then "yes" else "" end' 2>/dev/null || true)"
	fi
	say "  box       up at $ip${used:+   envs ${used}/${cap:-4}}"
	if [ -n "$mine" ]; then
		say "  your env  https://${slug}.dev.alethialabs.io   ·  pnpm env:down when finished"
	else
		say "  your env  none — pnpm env:up takes a slot (only if you need a RUNNING app)"
	fi
else
	say "  box       down or not created  →  pnpm env:box"
fi

say "  run it    pnpm env:up      ·  logs: pnpm env:logs  ·  push: pnpm env:push"
say "  NOT here  pnpm dev:up / dev:stack / compose:up are blocked on this Mac."

# Local headroom — the reason any of this exists. Cheap, no network.
# On macOS `/` is the read-only system volume and reports a flattering number; the
# volume that actually fills up is /System/Volumes/Data. On Linux `/` is correct.
disk_target=/
[ -d /System/Volumes/Data ] && disk_target=/System/Volumes/Data
avail="$(TO 3 df -h "$disk_target" 2>/dev/null | awk 'NR==2 {print $4" free ("$5" used)"}')"
[ -n "$avail" ] && say "  disk      ${avail}"

say "  details   .claude/skills/dev/SKILL.md  ·  CLAUDE.md → Running the app"
say "────────────────────────────────────────────────────────────"
exit 0
