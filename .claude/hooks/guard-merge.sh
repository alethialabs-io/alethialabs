#!/usr/bin/env bash
# PreToolUse(Bash) guard: a merge lands in `dev`, or is a GREEN promotion — nothing else.
#
# WHY THIS IS A HOOK AND NOT A PERMISSION RULE:
#   `gh pr merge 1535` does not say what it merges INTO. A permission rule matches command
#   text, so it can only choose between "block every merge" and "block none" — neither of
#   which is the policy. This resolves the PR's base AND head branches first, then decides.
#
# THE POLICY (maintainer ruling 2026-11-06: agents run the promotions when they are green):
#   base=dev                      allow   Mergify normally lands it; merging your own dev PR is permitted
#   base=staging, head=dev        allow   a PROMOTION — only with --merge, and only when green (below)
#   base=main,    head=staging    allow   a PROMOTION — the same conditions
#   any other staging/main merge  block   a hotfix or a skipped hop is the maintainer's
#   --admin                       block   bypasses the merge queue and the rules, whatever the base
#   unresolvable                  block   fail CLOSED — see below
#
# "GREEN" FOR A PROMOTION, checked through the gh API at the moment of the merge:
#   · `gh pr checks <n>` lists at least one check, and none is fail, pending or cancelled
#     (skipping is fine — a job whose `if:` did not apply did not fail);
#   · every release-gate leg passed: for each `{ project: "<leg>" }` row in
#     .github/workflows/release-gate.yml, a `Release gate (<leg>)` check exists with bucket
#     `pass`. Skipping is NOT fine here: deploy-console.yml's receipt refuses a production deploy
#     unless all seven legs are `success`, and a leg that never reported cannot have passed. Any
#     extra `Release gate (…)` check the PR carries must pass as well.
#   · the merge is `--merge` (a merge commit), never --squash/--rebase: a squashed promotion
#     loses the ancestry, so the NEXT promotion conflicts with everything this one carried.
#   · not `--auto`: auto-merge fires later, after only the REQUIRED checks — the release-gate
#     legs are not required checks, so "green now" would not be what lands.
#
# Fail-closed matters here. The failure modes for resolving a PR are "offline", "not a PR
# number" and "wrong repo", and in every one the safe answer is to refuse: an irreversible
# merge into main is exactly what we cannot undo. A guard that opens when the network hiccups
# is not a guard.
#
# Maintainer escape for anything else (a hotfix straight to main): ALETHIA_ALLOW_PROMOTION=1,
# exported before `claude` starts. Promotions no longer need it.
#
# BOUNDARY: it matches `gh pr merge` in the command text. A merge through `gh api` (PUT
# …/pulls/<n>/merge), the GitHub UI, or a script is not seen here; the staging/main rulesets
# are the server-side layer.

# ── Self-test ─────────────────────────────────────────────────────────────────────────────────
# Uses a stub `gh` on PATH and a fake release-gate.yml, so it needs no network, no auth and no
# real PRs. The exit code is the test.
if [ "${1:-}" = "--self-test" ]; then
	self="${BASH_SOURCE[0]}"
	case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
	stub="$(mktemp -d)"
	trap 'rm -rf "$stub"' EXIT
	mkdir -p "$stub/root/.github/workflows" "$stub/bin"
	cat >"$stub/root/.github/workflows/release-gate.yml" <<'YML'
          const legs = [
            { project: "hero",      args: "--project=hero" },
            { project: "qa",        args: "--project=qa" },
          ];
YML
	G='{"name":"Release gate (hero)","bucket":"pass","workflow":"Release gate"}'
	Q='{"name":"Release gate (qa)","bucket":"pass","workflow":"Release gate"}'
	C='{"name":"CI / Build","bucket":"pass","workflow":"CI"}'
	S='{"name":"CI / optional","bucket":"skipping","workflow":"CI"}'
	cat >"$stub/checks.tsv" <<EOF
1610	[$C,$S,$G,$Q]
1611	[$C,$G,$Q]
1612	[{"name":"CI / Build","bucket":"fail","workflow":"CI"},$G,$Q]
1613	[{"name":"CI / Build","bucket":"pending","workflow":"CI"},$G,$Q]
1614	[$C,$G]
1615	[$C,$G,{"name":"Release gate (qa)","bucket":"skipping","workflow":"Release gate"}]
1617	[$C,$G,$Q]
1618	[]
1619	[$C,$G,$Q,{"name":"Release gate (canvas)","bucket":"fail","workflow":"Release gate"}]
1620	[$C,$G,$Q,{"name":"CI / x","bucket":"cancel","workflow":"CI"}]
EOF
	# `gh pr view N --json baseRefName,headRefName …` prints "<base> <head>";
	# `gh pr checks N --json …` prints that PR's checks (1616: the lookup fails).
	cat >"$stub/bin/gh" <<STUB
#!/usr/bin/env bash
n=""
for a in "\$@"; do case "\$a" in [0-9]*) n="\$a" ;; esac; done
if [ "\$2" = view ]; then
	case "\$n" in
	1535) echo "dev feat/x" ;;
	1600) echo "staging feat/x" ;;
	1601) echo "main feat/x" ;;
	1610 | 1612 | 1613 | 1614 | 1615 | 1616 | 1618 | 1619 | 1620) echo "staging dev" ;;
	1611) echo "main staging" ;;
	1617) echo "main dev" ;;
	*) exit 1 ;;
	esac
	exit 0
fi
if [ "\$2" = checks ]; then
	[ "\$n" = 1616 ] && exit 1
	line="\$(grep "^\$n	" "$stub/checks.tsv")" || exit 1
	printf '%s\n' "\${line#*	}"
	# gh exits 8 while checks are pending and 1 when one failed — the JSON is still printed
	case "\$line" in *pending*) exit 8 ;; *fail*) exit 1 ;; esac
	exit 0
fi
exit 1
STUB
	chmod +x "$stub/bin/gh"

	pass=0
	fail=0
	t() { # <block|allow> <command>
		local got rc
		printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			PATH="$stub/bin:$PATH" CLAUDE_PROJECT_DIR="$stub/root" ALETHIA_ALLOW_PROMOTION= bash "$self" >/dev/null 2>&1
		rc=$?
		case "$rc" in 0) got=allow ;; 2) got=block ;; *) got="crash(rc=$rc)" ;; esac
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
	t block 'gh pr merge 1600'               # staging, not from dev: not a promotion
	t block 'gh pr merge 1601 --merge'       # main, not from staging
	t block 'gh pr merge 1535 --admin'       # bypasses the queue even on dev
	t block 'gh pr merge 999'                # unresolvable → fail closed
	t block 'gh pr merge'                    # no PR number → fail closed

	# ── promotions ──
	t allow 'gh pr merge 1610 --merge'       # dev → staging, green (a skipped non-gate job is fine)
	t allow 'gh pr merge --merge 1611'       # staging → main, green
	t block 'gh pr merge 1610'               # no --merge: a squash/rebase would break the next promotion
	t block 'gh pr merge 1610 --squash'
	t block 'gh pr merge 1610 --merge --rebase'
	t block 'gh pr merge 1610 --merge --auto' # auto-merge lands later, on required checks only
	t block 'gh pr merge 1610 --merge --admin'
	t block 'gh pr merge 1612 --merge'       # a failed check
	t block 'gh pr merge 1613 --merge'       # a pending check
	t block 'gh pr merge 1614 --merge'       # a release-gate leg never reported
	t block 'gh pr merge 1615 --merge'       # a release-gate leg SKIPPED is not a pass
	t block 'gh pr merge 1616 --merge'       # the checks lookup failed → fail closed
	t block 'gh pr merge 1617 --merge'       # dev → main skips staging
	t block 'gh pr merge 1618 --merge'       # no checks at all
	t block 'gh pr merge 1619 --merge'       # an extra gate leg the head names, failing
	t block 'gh pr merge 1620 --merge'       # a cancelled check
	# The leg list comes from release-gate.yml; with none parseable the guard fails closed.
	: >"$stub/root/.github/workflows/release-gate.yml"
	t block 'gh pr merge 1610 --merge'

	# Not our business.
	t allow 'gh pr view 1535'
	t allow 'gh pr checks 1535'
	t allow 'gh pr create --base dev'
	t allow 'git merge origin/dev'
	t allow 'echo gh pr merge 1601'          # inspection, not execution

	# The real release-gate.yml must yield legs, or every promotion would fail closed.
	real="$(cd "$(dirname "$self")/../.." && pwd)/.github/workflows/release-gate.yml"
	if [ -f "$real" ]; then
		n="$(grep -oE '\{[[:space:]]*project:[[:space:]]*"[^"]+"' "$real" | wc -l | tr -d ' ')"
		if [ "$n" -ge 1 ]; then pass=$((pass + 1)); else
			fail=$((fail + 1))
			echo "  ✗ no release-gate legs parse out of $real"
		fi
	fi

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

# Maintainer override for a non-promotion merge into staging/main. Must be EXPORTED before
# `claude` starts — a PreToolUse hook is spawned before the Bash tool runs.
[ "${ALETHIA_ALLOW_PROMOTION:-}" = "1" ] && exit 0

# Only `gh pr merge`. Inspection (`echo gh pr merge …`) is data, matching the
# search-or-print carve-out guard-runtime.sh uses.
printf '%s' "$cmd" | grep -Eq '(^|[^a-zA-Z0-9_-])gh[[:space:]]+pr[[:space:]]+merge\b' || exit 0
printf '%s' "$cmd" | grep -Eq '^[[:space:]]*(echo|printf|grep|rg|cat)\b' && exit 0

deny() {
	echo "BLOCKED: $1" >&2
	echo "" >&2
	echo "  Branch flow is feature → dev → staging → main. Feature work targets \`dev\`." >&2
	echo "  Promotions (dev → staging, staging → main) are agents' work WHEN GREEN:" >&2
	echo "    gh pr merge <n> --merge   — every check passed and every release-gate leg passed." >&2
	echo "  Anything else into staging/main is the maintainer's: ask the maintainer." >&2
	exit 2
}

# --admin bypasses the merge queue, so it is refused regardless of base. That bypass is
# what makes a stale-green PR able to break dev, which is the whole reason for the queue.
if printf '%s' "$cmd" | grep -Eq '(^|[[:space:]])--admin([[:space:]]|=|$)'; then
	deny "\`gh pr merge --admin\` bypasses the Mergify queue and the branch rules."
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

refs="$(gh pr view "$pr" --json baseRefName,headRefName -q '.baseRefName + " " + .headRefName' 2>/dev/null)"
base="${refs%% *}"
head="${refs#* }"
[ "$refs" = "$head" ] && head=""

case "$base" in
dev)
	exit 0
	;;
"")
	deny "could not resolve the base branch of PR #$pr (offline, or not a PR in this repo)."
	;;
staging | main) ;;
*)
	# An unrecognised base is not necessarily wrong, but it is not `dev` either — and the
	# only bases that should exist here are dev/staging/main.
	deny "PR #$pr targets \`$base\`, which is not \`dev\`."
	;;
esac

# ── a staging/main base: only a promotion, only green ─────────────────────────────────────────
case "$base:$head" in
staging:dev | main:staging) ;;
*) deny "PR #$pr merges \`${head:-?}\` into \`$base\`. Only dev → staging and staging → main are promotions." ;;
esac

case " $cmd " in
*" --squash"* | *" -s "* | *" --rebase"* | *" -r "*)
	deny "promotion PR #$pr must land as a merge commit (--merge); a squash or rebase drops the ancestry the next promotion needs."
	;;
esac
case " $cmd " in *" --merge"* | *" -m "*) ;; *)
	deny "promotion PR #$pr must say --merge explicitly (a merge commit, not a squash)."
	;;
esac
case " $cmd " in *" --auto"*)
	deny "\`--auto\` on promotion PR #$pr would land it later on REQUIRED checks only; the release-gate legs are not required checks. Merge it once it is green."
	;;
esac

# gh exits 8 while checks are pending and 1 when one failed, printing the JSON either way, so
# the exit code is not the signal: the JSON is, and an unparseable answer fails closed.
checks="$(gh pr checks "$pr" --json name,bucket,workflow 2>/dev/null)"
printf '%s' "$checks" | jq -e 'type == "array"' >/dev/null 2>&1 ||
	deny "could not read the checks of promotion PR #$pr (offline, or gh failed)."
# Subsumed by the leg check below (an empty list has no passing leg) — kept for the message.
printf '%s' "$checks" | jq -e 'length > 0' >/dev/null 2>&1 ||
	deny "promotion PR #$pr reports no checks at all — nothing has proven it green."

notgreen="$(printf '%s' "$checks" | jq -r '[.[] | select(.bucket != "pass" and .bucket != "skipping") | "\(.name) (\(.bucket))"] | join(", ")')"
[ -z "$notgreen" ] || deny "promotion PR #$pr is not green: $notgreen."

# Every release-gate leg the gate's own table names must have PASSED (skipping is not passing),
# and so must any extra `Release gate (…)` check the PR carries.
gate_yml="${CLAUDE_PROJECT_DIR:-.}/.github/workflows/release-gate.yml"
legs="$(grep -oE '\{[[:space:]]*project:[[:space:]]*"[^"]+"' "$gate_yml" 2>/dev/null | sed -E 's/.*"([^"]+)"/\1/')"
[ -n "$legs" ] || deny "could not read the release-gate legs from $gate_yml, so PR #$pr cannot be shown green."
missing="$(printf '%s' "$checks" | jq -r --arg legs "$legs" '
	. as $c
	| ($legs | split("\n") | map(select(length > 0)) | map("Release gate (\(.))")) as $want
	| ([$want[] | . as $n | select(([$c[] | select(.name == $n and .bucket == "pass")] | length) == 0)]
	   + [$c[] | select((.name | startswith("Release gate (")) and .bucket != "pass") | .name])
	| unique | join(", ")')"
[ -z "$missing" ] || deny "promotion PR #$pr: these release-gate legs have not passed: $missing."

exit 0
