#!/usr/bin/env bash
# PreToolUse(Bash) guard: a merge may land in `dev`, never in `staging` or `main`.
#
# WHY THIS IS A HOOK AND NOT A PERMISSION RULE:
#   `gh pr merge 1535` does not say what it merges INTO. A permission rule matches command
#   text, so it can only choose between "block every merge" and "block none" — neither of
#   which is the policy. This resolves the PR's base branch first, then decides.
#
# THE POLICY:
#   base=dev      allow   Mergify normally lands it, but merging your own dev PR is permitted
#   base=staging  block   promotions are the maintainer's, via --merge
#   base=main     block
#   --admin       block   bypasses the merge queue entirely, whatever the base
#   unresolvable  block   fail CLOSED — see below
#
# Fail-closed matters here. The failure modes for resolving a base are "offline", "not a PR
# number" and "wrong repo" — and in every one of them the safe answer is to refuse, because
# the thing we are guarding against (an irreversible merge into main) is exactly what we
# cannot undo. A guard that opens up when the network hiccups is not a guard.
#
# Mirrors .claude/hooks/guard-runtime.sh. Exit 2 = block and show stderr to the model.

# ── Self-test ─────────────────────────────────────────────────────────────────────
# Uses a stub `gh` on PATH, so it needs no network, no auth and no real PRs.
if [ "${1:-}" = "--self-test" ]; then
	self="${BASH_SOURCE[0]}"
	case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
	stub="$(mktemp -d)"
	trap 'rm -rf "$stub"' EXIT

	# Maps a PR number to a base branch; 999 is the unresolvable case.
	cat >"$stub/gh" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
	case "$a" in
	1535) echo dev; exit 0 ;;
	1600) echo staging; exit 0 ;;
	1601) echo main; exit 0 ;;
	999) exit 1 ;;
	esac
done
exit 1
STUB
	chmod +x "$stub/gh"

	pass=0
	fail=0
	t() { # <block|allow> <command>
		local got rc
		printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			PATH="$stub:$PATH" ALETHIA_ALLOW_PROMOTION= bash "$self" >/dev/null 2>&1
		rc=$?
		[ "$rc" = 2 ] && got=block || got=allow
		if [ "$got" = "$1" ]; then
			pass=$((pass + 1))
		else
			fail=$((fail + 1))
			echo "  ✗ want=$1 got=$got : $2"
		fi
	}

	t allow 'gh pr merge 1535'
	t allow 'gh pr merge 1535 --squash'
	t allow 'gh pr merge --squash 1535'
	t block 'gh pr merge 1600'          # staging
	t block 'gh pr merge 1601'          # main
	t block 'gh pr merge 1535 --admin'  # bypasses the queue even on dev
	t block 'gh pr merge 999'           # base unresolvable → fail closed
	t block 'gh pr merge'               # no PR number → cannot resolve → fail closed

	# Not our business.
	t allow 'gh pr view 1535'
	t allow 'gh pr checks 1535'
	t allow 'gh pr create --base dev'
	t allow 'git merge origin/dev'
	t allow 'echo gh pr merge 1601'     # inspection, not execution

	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
	exit $?
fi

input="$(cat)"

# Read the command field, not the raw payload — the lesson from guard-worktree.sh's R-MAIN,
# which rejected any edit whose CONTENT mentioned a blocked phrase.
if command -v jq >/dev/null 2>&1; then
	cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
	cmd="$(printf '%s' "$input" |
		grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' |
		sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//; s/"$//' |
		sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')"
fi
[ -n "$cmd" ] || exit 0

# Maintainer override for a real promotion. Must be EXPORTED before `claude` starts — a
# PreToolUse hook is spawned before the Bash tool runs, so an inline prefix never reaches it.
[ "${ALETHIA_ALLOW_PROMOTION:-}" = "1" ] && exit 0

# Only `gh pr merge`. Inspection (`echo gh pr merge …`) is data, matching the
# search-or-print carve-out guard-runtime.sh uses.
printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])gh[[:space:]]+pr[[:space:]]+merge\b' || exit 0
printf '%s' "$cmd" | grep -Eq '^[[:space:]]*(echo|printf|grep|rg|cat)\b' && exit 0

deny() {
	echo "BLOCKED: $1" >&2
	echo "" >&2
	echo "  Branch flow is feature → dev → staging → main. Feature work targets \`dev\`;" >&2
	echo "  the maintainer promotes with a merge commit, not a squash." >&2
	echo "  Deliberate promotion: export ALETHIA_ALLOW_PROMOTION=1 BEFORE launching claude." >&2
	exit 2
}

# --admin bypasses the merge queue, so it is refused regardless of base. That bypass is
# what makes a stale-green PR able to break dev, which is the whole reason for the queue.
if printf '%s' "$cmd" | grep -Eq '(^|[[:space:]])--admin([[:space:]]|$)'; then
	deny "\`gh pr merge --admin\` bypasses the Mergify queue."
fi

# The PR number: the first bare integer after `merge` (flags and their values are skipped).
pr="$(printf '%s' "$cmd" |
	sed -E 's/.*gh[[:space:]]+pr[[:space:]]+merge//' |
	tr ' ' '\n' | grep -E '^[0-9]+$' | head -1)"

if [ -z "$pr" ]; then
	# `gh pr merge` with no number means "the PR for the current branch" — which this hook
	# cannot resolve without knowing the branch, so it fails closed rather than guessing.
	deny "cannot tell which PR (and so which base branch) this merges."
fi

base="$(gh pr view "$pr" --json baseRefName -q .baseRefName 2>/dev/null | tr -d '[:space:]')"

case "$base" in
dev)
	exit 0
	;;
staging | main)
	deny "PR #$pr targets \`$base\`."
	;;
"")
	deny "could not resolve the base branch of PR #$pr (offline, or not a PR in this repo)."
	;;
*)
	# An unrecognised base is not necessarily wrong, but it is not `dev` either — and the
	# only bases that should exist here are dev/staging/main.
	deny "PR #$pr targets \`$base\`, which is not \`dev\`."
	;;
esac
