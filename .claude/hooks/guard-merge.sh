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
#   base=staging, head=dev        allow   a PROMOTION — only as below, and only when green
#   base=main,    head=staging    allow   a PROMOTION — the same conditions
#   any other staging/main merge  block   a hotfix or a skipped hop is the maintainer's
#   --admin                       block   bypasses the merge queue and the rules, whatever the base
#   more than one `gh pr merge`   block   one command, one merge, one verdict
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
#   · `--match-head-commit <sha>` names the head those checks were read for. `dev` moves on every
#     queue merge, so without it a newer, unchecked head could land between this hook and the
#     merge; with it, GitHub refuses the merge if the head moved. A merge without it is refused
#     with the exact command to run.
#   · the merge is `--merge` (a merge commit), never --squash/--rebase: a squashed promotion
#     loses the ancestry, so the NEXT promotion conflicts with everything this one carried.
#   · not `--auto`: auto-merge fires later, on whatever the base branch REQUIRES at that time.
#     protect-staging requires none of the release-gate legs (protect-main requires all seven),
#     and this hook can only vouch for the state it read — so for staging "green now" would not
#     be what lands, and for main the rule keeps one behaviour for both hops.
#   · not `-d/--delete-branch`: the head of a promotion IS dev or staging. The rulesets stop the
#     remote delete, but gh also deletes the LOCAL branch when run from a tree on it.
#
# Fail-closed matters here. The failure modes for resolving a PR are "offline", "not a PR
# number" and "wrong repo", and in every one the safe answer is to refuse: an irreversible
# merge into main is exactly what we cannot undo. Without jq the command cannot be read, and a
# payload mentioning `pr merge` is refused rather than waved through.
#
# CRASH DIRECTION: a CRASH (exit not 0/2) is an allow — no hook sets `onFailure: "block"`, and a
# guard bug must never brick every Bash call. Every refusal above is an explicit exit 2.
#
# gh's global flags before the subcommand are parsed by lib/cmdline.sh, the parser the spend and
# deletion guards share, and the PR is looked up in the repository they name.
#
# Maintainer escape for anything else (a hotfix straight to main): ALETHIA_ALLOW_PROMOTION=1,
# exported before `claude` starts. Promotions no longer need it.
#
# BOUNDARY: it matches `gh pr merge` in the command text. A merge through `gh api` (PUT
# …/pulls/<n>/merge), the GitHub UI, or a script is not seen here; the staging/main rulesets
# are the server-side layer.

_self="${BASH_SOURCE[0]}"
case "$_self" in */*) HOOK_DIR="${_self%/*}" ;; *) HOOK_DIR="." ;; esac
# shellcheck source=lib/cmdline.sh
. "$HOOK_DIR/lib/cmdline.sh"

deny() {
	echo "BLOCKED: $1" >&2
	echo "" >&2
	echo "  Branch flow is feature → dev → staging → main. Feature work targets \`dev\`." >&2
	echo "  Promotions (dev → staging, staging → main) are agents' work WHEN GREEN:" >&2
	echo "    gh pr merge <n> --merge --match-head-commit <head sha>" >&2
	echo "  — every check passed and every release-gate leg passed, for exactly that head." >&2
	echo "  Anything else into staging/main is the maintainer's: ask the maintainer." >&2
	exit 2
}

# repo_args <owner/repo> — the lookups go to the repository the merge names.
repo_args() { rargs=(-R "$1"); }

main() {
	cmdline_read_payload
	if [ -n "$CMDLINE_NO_JQ" ]; then
		if [[ "$CMDLINE_RAW" =~ pr[[:space:]]+merge ]]; then
			# @mut merge-nojq
			deny "jq is not installed, so the guard cannot read this \`gh pr merge\` — refusing rather than merging blind. Install jq (brew install jq)."
		fi
		exit 0
	fi
	[ -n "$CMD" ] || exit 0

	# Maintainer override for a non-promotion merge into staging/main. Must be EXPORTED before
	# `claude` starts — a PreToolUse hook is spawned before the Bash tool runs.
	[ "${ALETHIA_ALLOW_PROMOTION:-}" = "1" ] && exit 0

	case "$CMD" in *merge*) ;; *) exit 0 ;; esac

	# Find every `gh pr merge` segment. Inspection (`echo gh pr merge …`) is data.
	local raw merges=0 margs=() repo=""
	cmdline_split "$CMD"
	for raw in "${SEGS[@]}"; do
		cmdline_normalise "$raw"
		[ ${#TOK[@]} -gt 0 ] || continue
		cmdline_is_inspect && continue
		[ "${TOK[0]##*/}" = gh ] && [ "${TOK[1]:-}" = pr ] && [ "${TOK[2]:-}" = merge ] || continue
		merges=$((merges + 1))
		margs=("${TOK[@]:3}")
		repo="$CMDLINE_GH_REPO"
	done
	[ "$merges" -gt 0 ] || exit 0
	if [ "$merges" -gt 1 ]; then
		# @mut merge-count
		deny "this command runs $merges \`gh pr merge\`s; each merge must be checked on its own. Run them one at a time."
	fi

	# Flags, their values, and the PR. `-R/--repo` after the subcommand counts too.
	local i n=${#margs[@]} a pr="" mhc="" admin=0 squash=0 rebase=0 merge=0 auto=0 delbranch=0
	for ((i = 0; i < n; i++)); do
		a="${margs[$i]}"
		case "$a" in
		--admin) admin=1 ;;
		-s | --squash) squash=1 ;;
		-r | --rebase) rebase=1 ;;
		-m | --merge) merge=1 ;;
		--auto) auto=1 ;;
		-d | --delete-branch) delbranch=1 ;;
		-R | --repo)
			repo="${margs[$((i + 1))]:-}"
			i=$((i + 1))
			;;
		--repo=*) repo="${a#--repo=}" ;;
		--match-head-commit)
			mhc="${margs[$((i + 1))]:-}"
			i=$((i + 1))
			;;
		--match-head-commit=*) mhc="${a#--match-head-commit=}" ;;
		-t | --subject | -b | --body | -F | --body-file | -A | --author-email) i=$((i + 1)) ;;
		-*) ;;
		*/pull/[0-9]*)
			[ -n "$pr" ] || pr="${a##*/pull/}"
			pr="${pr%%[!0-9]*}"
			;;
		*) case "$a" in *[!0-9]*) ;; *) [ -n "$pr" ] || pr="$a" ;; esac ;;
		esac
	done

	# --admin bypasses the merge queue, so it is refused regardless of base. That bypass is
	# what makes a stale-green PR able to break dev, which is the whole reason for the queue.
	if [ "$admin" = 1 ]; then
		# @mut merge-admin
		deny "\`gh pr merge --admin\` bypasses the Mergify queue and the branch rules."
	fi
	if [ -z "$pr" ]; then
		# `gh pr merge` with no number means "the PR for the current branch" — which this hook
		# cannot resolve without knowing the branch, so it fails closed rather than guessing.
		deny "cannot tell which PR (and so which base branch) this merges."
	fi

	local rargs=()
	if [ -n "$repo" ]; then
		# @mut merge-repo
		repo_args "$repo"
	fi
	local refs base head sha
	refs="$(gh pr view "$pr" "${rargs[@]}" --json baseRefName,headRefName,headRefOid -q '.baseRefName + " " + .headRefName + " " + .headRefOid' 2>/dev/null)"
	read -r base head sha <<<"$refs"

	case "$base" in
	dev) exit 0 ;;
	"") deny "could not resolve the base branch of PR #$pr${repo:+ in $repo} (offline, or not a PR in that repo)." ;;
	staging | main) ;;
	*)
		# An unrecognised base is not necessarily wrong, but it is not `dev` either — and the
		# only bases that should exist here are dev/staging/main.
		deny "PR #$pr targets \`$base\`, which is not \`dev\`."
		;;
	esac

	# ── a staging/main base: only a promotion, only green ─────────────────────────────────────
	case "$base:$head" in
	staging:dev | main:staging) ;;
	*) deny "PR #$pr merges \`${head:-?}\` into \`$base\`. Only dev → staging and staging → main are promotions." ;;
	esac
	if [ "$squash" = 1 ] || [ "$rebase" = 1 ]; then
		deny "promotion PR #$pr must land as a merge commit (--merge); a squash or rebase drops the ancestry the next promotion needs."
	fi
	[ "$merge" = 1 ] || deny "promotion PR #$pr must say --merge explicitly (a merge commit, not a squash)."
	if [ "$auto" = 1 ]; then
		deny "\`--auto\` on promotion PR #$pr would land it later, on whatever $base requires then — not on the state this guard checks. Merge it once it is green."
	fi
	if [ "$delbranch" = 1 ]; then
		# @mut merge-delete-branch
		deny "\`--delete-branch\` on promotion PR #$pr would delete \`$head\` — the integration branch itself."
	fi
	[ -n "$sha" ] || deny "could not read the head commit of promotion PR #$pr, so the checks cannot be tied to what lands."
	local exact="gh pr merge $pr${repo:+ -R $repo} --merge --match-head-commit $sha"
	if [ -z "$mhc" ]; then
		# @mut merge-mhc-missing
		deny "promotion PR #$pr must name the head its checks were verified for. Run:  $exact"
	fi
	if [ "$mhc" != "$sha" ]; then
		# @mut merge-mhc-mismatch
		deny "promotion PR #$pr: --match-head-commit $mhc is not its head ($sha) — the head moved, and the new one is what the checks below describe. Re-check, then run:  $exact"
	fi

	# gh exits 8 while checks are pending and 1 when one failed, printing the JSON either way, so
	# the exit code is not the signal: the JSON is, and an unparseable answer fails closed.
	local checks notgreen gate_yml legs missing
	checks="$(gh pr checks "$pr" "${rargs[@]}" --json name,bucket,workflow 2>/dev/null)"
	printf '%s' "$checks" | jq -e 'type == "array"' >/dev/null 2>&1 ||
		deny "could not read the checks of promotion PR #$pr (offline, or gh failed)."
	# Subsumed by the leg check below (an empty list has no passing leg) — kept for the message.
	printf '%s' "$checks" | jq -e 'length > 0' >/dev/null 2>&1 ||
		deny "promotion PR #$pr reports no checks at all — nothing has proven it green."

	notgreen="$(printf '%s' "$checks" | jq -r '[.[] | select(.bucket != "pass" and .bucket != "skipping") | "\(.name) (\(.bucket))"] | join(", ")')"
	if [ -n "$notgreen" ]; then
		# @mut merge-notgreen
		deny "promotion PR #$pr is not green: $notgreen."
	fi

	# Every release-gate leg the gate's own table names must have PASSED (skipping is not
	# passing), and so must any extra `Release gate (…)` check the PR carries.
	gate_yml="${CLAUDE_PROJECT_DIR:-.}/.github/workflows/release-gate.yml"
	legs="$(grep -oE '\{[[:space:]]*project:[[:space:]]*"[^"]+"' "$gate_yml" 2>/dev/null | sed -E 's/.*"([^"]+)"/\1/')"
	[ -n "$legs" ] || deny "could not read the release-gate legs from $gate_yml, so PR #$pr cannot be shown green."
	missing="$(printf '%s' "$checks" | jq -r --arg legs "$legs" '
		. as $c
		| ($legs | split("\n") | map(select(length > 0)) | map("Release gate (\(.))")) as $want
		| ([$want[] | . as $n | select(([$c[] | select(.name == $n and .bucket == "pass")] | length) == 0)]
		   + [$c[] | select((.name | startswith("Release gate (")) and .bucket != "pass") | .name])
		| unique | join(", ")')"
	if [ -n "$missing" ]; then
		# @mut merge-legs
		deny "promotion PR #$pr: these release-gate legs have not passed: $missing."
	fi
	exit 0
}

# ── Self-test ─────────────────────────────────────────────────────────────────────────────────
# Uses a stub `gh` on PATH and a fake release-gate.yml, so it needs no network, no auth and no
# real PRs. The exit code is the test.
self_test() {
	local self="$1" stub pass=0 fail=0
	stub="$(mktemp -d)"
	trap 'rm -rf "$stub"' EXIT
	mkdir -p "$stub/root/.github/workflows" "$stub/bin" "$stub/nojq"
	cat >"$stub/root/.github/workflows/release-gate.yml" <<'YML'
          const legs = [
            { project: "hero",      args: "--project=hero" },
            { project: "qa",        args: "--project=qa" },
          ];
YML
	local G Q C S
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
1700	[$C,$G,$Q]
EOF
	# `gh pr view N --json …` prints "<base> <head> <sha>"; `gh pr checks N --json …` prints that
	# PR's checks (1616: the lookup fails). PR 1700 exists ONLY in o/other, so it is found only
	# when the repository flag reaches the lookup.
	cat >"$stub/bin/gh" <<STUB
#!/usr/bin/env bash
n=""
other=0
for a in "\$@"; do case "\$a" in [0-9]*) n="\$a" ;; o/other) other=1 ;; esac; done
if [ "\$n" = 1700 ] && [ "\$other" != 1 ]; then exit 1; fi
if [ "\$2" = view ]; then
	case "\$n" in
	1535) echo "dev feat/x 1535aaa" ;;
	1600) echo "staging feat/x 1600aaa" ;;
	1601) echo "main feat/x 1601aaa" ;;
	1610 | 1612 | 1613 | 1614 | 1615 | 1616 | 1618 | 1619 | 1620) echo "staging dev aaa\$n" ;;
	1611) echo "main staging aaa1611" ;;
	1617) echo "main dev aaa1617" ;;
	1700) echo "staging dev aaa1700" ;;
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
	ln -sf "$(command -v cat)" "$stub/nojq/cat"

	t() { # <block|allow> <command> [PATH-override]
		local got rc path="${3:-$stub/bin:$PATH}"
		printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
			"$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" |
			env PATH="$path" CLAUDE_PROJECT_DIR="$stub/root" ALETHIA_ALLOW_PROMOTION= "$BASH" "$self" >/dev/null 2>"$stub/stderr"
		rc=$?
		case "$rc" in 0) got=allow ;; 2) got=block ;; *) got="crash(rc=$rc)" ;; esac
		if [ "$got" = "$1" ]; then
			pass=$((pass + 1))
		else
			fail=$((fail + 1))
			echo "  ✗ want=$1 got=$got : $2"
			[ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
		fi
	}
	says() { # <text> <label> — the last refusal's message contains <text>
		if grep -qF -- "$1" "$stub/stderr"; then pass=$((pass + 1)); else
			fail=$((fail + 1))
			echo "  ✗ $2: $(head -c 300 "$stub/stderr")"
			[ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
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
	t allow 'gh pr merge 1610 --merge --match-head-commit aaa1610'  # green (a skipped non-gate job is fine)
	t allow 'gh pr merge --merge 1611 --match-head-commit=aaa1611'  # staging → main, green
	t allow 'gh pr merge https://github.com/o/r/pull/1610 --merge --match-head-commit aaa1610'
	t block 'gh pr merge 1610 --merge'       # no --match-head-commit: refused WITH the command to run
	says 'must name the head its checks were verified for' 'a missing --match-head-commit is its own refusal'
	says 'gh pr merge 1610 --merge --match-head-commit aaa1610' 'the refusal names the exact command'
	t block 'gh pr merge 1610 --merge --match-head-commit bbb999'  # the head moved
	says 'is not its head' 'a mismatched head is named'
	t block 'gh pr merge 1610 --match-head-commit aaa1610'   # no --merge
	t block 'gh pr merge 1610 --squash --match-head-commit aaa1610'
	t block 'gh pr merge 1610 --merge --rebase --match-head-commit aaa1610'
	t block 'gh pr merge 1610 --merge --auto --match-head-commit aaa1610'
	t block 'gh pr merge 1610 --merge --admin --match-head-commit aaa1610'
	t block 'gh pr merge 1610 --merge -d --match-head-commit aaa1610'   # would delete dev locally
	says 'delete-branch' 'the delete-branch refusal says why'
	t block 'gh pr merge 1610 --merge --delete-branch --match-head-commit aaa1610'
	t block 'gh pr merge 1612 --merge --match-head-commit aaa1612'   # a failed check
	t block 'gh pr merge 1613 --merge --match-head-commit aaa1613'   # a pending check
	t block 'gh pr merge 1614 --merge --match-head-commit aaa1614'   # a release-gate leg never reported
	says 'Release gate (qa)' 'the missing leg is named'
	t block 'gh pr merge 1615 --merge --match-head-commit aaa1615'   # a release-gate leg SKIPPED is not a pass
	t block 'gh pr merge 1616 --merge --match-head-commit aaa1616'   # the checks lookup failed → fail closed
	t block 'gh pr merge 1617 --merge --match-head-commit aaa1617'   # dev → main skips staging
	t block 'gh pr merge 1618 --merge --match-head-commit aaa1618'   # no checks at all
	t block 'gh pr merge 1619 --merge --match-head-commit aaa1619'   # an extra gate leg the head names, failing
	t block 'gh pr merge 1620 --merge --match-head-commit aaa1620'   # a cancelled check
	says 'not green' 'a cancelled check is named as not green'

	# ── gh's global flags before the subcommand, and the repository they name ──
	t block 'gh -R o/r pr merge 1601 --merge'
	t block 'gh --repo o/r pr merge 1612 --merge --match-head-commit aaa1612'
	t allow 'gh -R o/r pr merge 1535 --squash'
	t allow 'gh -R o/other pr merge 1700 --merge --match-head-commit aaa1700'
	t allow 'gh pr merge 1700 --merge --match-head-commit aaa1700 -R o/other'
	t block 'gh pr merge 1700 --merge --match-head-commit aaa1700'   # not in the cwd's repo → unresolvable

	# ── one merge per command ──
	t block 'gh pr merge 1610 --merge --match-head-commit aaa1610 && gh pr merge 1535 --squash'
	t block 'gh pr merge 1535 --squash; gh pr merge 1601 --merge'
	says 'one at a time' 'the count refusal says why'

	# ── no jq: a merge is refused, anything else allowed ──
	t block 'gh pr merge 1535' "$stub/nojq"
	t allow 'git status' "$stub/nojq"

	# The leg list comes from release-gate.yml; with none parseable the guard fails closed.
	: >"$stub/root/.github/workflows/release-gate.yml"
	t block 'gh pr merge 1610 --merge --match-head-commit aaa1610'

	# Not our business.
	t allow 'gh pr view 1535'
	t allow 'gh pr checks 1535'
	t allow 'gh pr create --base dev'
	t allow 'git merge origin/dev'
	t allow 'echo gh pr merge 1601'          # inspection, not execution
	t allow 'git commit -m "docs: gh pr merge needs --match-head-commit for a promotion"'

	# The real release-gate.yml must yield legs, or every promotion would fail closed.
	local real n
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
}

# Targeted mutants: each `# @mut <name>` line (here and in lib/cmdline.sh) disables the statement
# on the next line; the self-test must FAIL for every one. See guard-destroy.sh's mutation_test.
mutation_test() {
	local self="$1" dir names name killed=0 survived=0 lib="${1%/*}/lib/cmdline.sh"
	dir="$(mktemp -d)"
	trap 'rm -rf "$dir"' EXIT
	mkdir -p "$dir/lib"
	names="$(cat "$self" "$lib" | grep -oE '# @mut(-sub)? [a-z0-9-]+' | awk '{print $3}' | sort -u)"
	for name in $names; do
		cp "$self" "$dir/guard-merge.sh"
		cp "$lib" "$dir/lib/cmdline.sh"
		perl -i -pe 'BEGIN { $n = shift @ARGV }
			if ($next) { if (defined $sub && length $sub) { eval $sub } else { s/^(\s*)\S+/$1true/ } $next = 0 }
			if (/^\s*# \@mut(-sub)? \Q$n\E(?:\s+(.*))?$/) { $next = 1; $sub = $2 }' "$name" "$dir/guard-merge.sh" "$dir/lib/cmdline.sh"
		if cmp -s "$self" "$dir/guard-merge.sh" && cmp -s "$lib" "$dir/lib/cmdline.sh"; then
			survived=$((survived + 1))
			echo "  ✗ marker $name did not apply"
			continue
		fi
		if SELFTEST_FAILFAST=1 bash "$dir/guard-merge.sh" --self-test >/dev/null 2>&1; then
			survived=$((survived + 1))
			echo "  ✗ mutant SURVIVED: disabling @$name fails no self-test case"
		else
			killed=$((killed + 1))
			echo "  ✓ disabling @$name fails the self-test"
		fi
	done
	echo "  ${killed} mutants killed, ${survived} survived"
	[ "$survived" -eq 0 ] && [ "$killed" -gt 0 ]
}

case "${1:-}" in
--self-test | --mutation-test)
	_s="$_self"
	case "$_s" in /*) ;; *) _s="$PWD/$_s" ;; esac
	if [ "$1" = --self-test ]; then self_test "$_s"; else mutation_test "$_s"; fi
	exit $?
	;;
esac
main
