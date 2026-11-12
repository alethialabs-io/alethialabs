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
#   base=main,    head=release-please--branches--main--components--<c>
#                                 allow   a RELEASE PR — the same conditions, plus the three below
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
#     extra `Release gate (…)` check the PR carries must pass as well — except the literal
#     `Release gate (${{ matrix.project }})` when SKIPPED: a run whose gate job did not apply never
#     expands its matrix, so that check names no leg (#6590 was refused on exactly this).
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
# A RELEASE PR (maintainer ruling 2026-11-11: "get it all to main, I authorize the merges") is the
# release-please PR that bumps one component's version on `main`. It merges under every promotion
# condition above, and only when, read from the API rather than from anything the command says:
#   · the head branch matches ^release-please--branches--main--components--[a-z0-9-]+$ — whole, so
#     a branch that only CONTAINS that name (a prefix, a `/suffix`) is not one;
#   · the PR's author login is `app/alethia-labs-ci`, the GitHub App release-please.yml mints its
#     token from. A login with a `/` cannot be a user account, and the author is not editable text;
#   · every changed file is MODIFIED or ADDED and is on the allowlist DERIVED from
#     release-please-config.json: `.release-please-manifest.json`, each package's changelog-path
#     (CHANGELOG.md by default) and each package's `extra-files`. A release PR carrying anything
#     else — code, a workflow, the config itself, a rename — is refused. The list is read from
#     `gh pr view --json files,changedFiles`, and a list shorter than changedFiles (gh reads at most
#     100) is refused rather than judged on the part it saw.
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
	echo "  A release-please PR into main merges the same way, when its author and files are release-please's." >&2
	echo "  Anything else into staging/main is the maintainer's: ask the maintainer." >&2
	exit 2
}

# The release PR rule's two constants. The head pattern is built in two halves so that each anchor
# is a mutant of its own.
# @mut-sub release-re-start s/\^//
RELEASE_HEAD_RE='^release-please--branches--main--components--'
# @mut-sub release-re-end s/\$'/'/
RELEASE_HEAD_RE+='[a-z0-9-]+$'
RELEASE_AUTHOR='app/alethia-labs-ci'

# merge_args_from_words <raw segment> — set margs from the segment's quote-aware words: skip to
# the `gh`, past gh's global flags, past `pr merge`. Leaves margs alone when that shape is not found.
merge_args_from_words() {
	local i=0 n
	cmdline_qwords "$1"
	n=${#QWORDS[@]}
	while [ "$i" -lt "$n" ] && [ "${QWORDS[$i]##*/}" != gh ]; do i=$((i + 1)); done
	i=$((i + 1))
	while [ "$i" -lt "$n" ]; do
		case "${QWORDS[$i]}" in
		-R | --repo | --hostname) i=$((i + 2)) ;;
		-*) i=$((i + 1)) ;;
		*) break ;;
		esac
	done
	[ "${QWORDS[$i]:-}" = pr ] && [ "${QWORDS[$((i + 1))]:-}" = merge ] || return 0
	margs=("${QWORDS[@]:$((i + 2))}")
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
		repo="$CMDLINE_GH_REPO"
		# The arguments, read as shell WORDS so a quoted option value is one word. Falls back to
		# TOK only when the segment's own words cannot be lined up (a `bash -c "…"` body).
		margs=("${TOK[@]:3}")
		# @mut merge-qwords
		merge_args_from_words "$raw"
	done
	[ "$merges" -gt 0 ] || exit 0
	if [ "$merges" -gt 1 ]; then
		# @mut merge-count
		deny "this command runs $merges \`gh pr merge\`s; each merge must be checked on its own. Run them one at a time."
	fi

	# Flags, their values, and the PR. `-R/--repo` after the subcommand counts too. The PR is the
	# FIRST positional word, structurally — never "the first number anywhere", which would read a
	# number inside a --subject/--body value as the PR and check the wrong one.
	local i n=${#margs[@]} a pr="" sel="" mhc="" admin=0 squash=0 rebase=0 merge=0 auto=0 delbranch=0
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
		*) [ -n "$sel" ] || sel="$a" ;;
		esac
	done
	case "$sel" in
	*/pull/[0-9]*)
		pr="${sel##*/pull/}"
		pr="${pr%%[!0-9]*}"
		;;
	*[!0-9]* | "") pr="" ;;
	*) pr="$sel" ;;
	esac

	# --admin bypasses the merge queue, so it is refused regardless of base. That bypass is
	# what makes a stale-green PR able to break dev, which is the whole reason for the queue.
	if [ "$admin" = 1 ]; then
		# @mut merge-admin
		deny "\`gh pr merge --admin\` bypasses the Mergify queue and the branch rules."
	fi
	if [ -z "$pr" ]; then
		# `gh pr merge` with no number means "the PR for the current branch" — which this hook
		# cannot resolve without knowing the branch, so it fails closed rather than guessing.
		deny "cannot tell which PR (and so which base branch) this merges${sel:+ — '$sel' is not a PR number or URL}."
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

	# ── a staging/main base: only a promotion or a release PR, only green ─────────────────────
	local kind
	case "$base:$head" in
	staging:dev | main:staging) kind=promotion ;;
	main:*)
		kind=release
		if ! [[ "$head" =~ $RELEASE_HEAD_RE ]]; then
			# @mut release-branch
			deny "PR #$pr merges \`${head:-?}\` into \`main\`. Only staging → main and a release-please PR (head release-please--branches--main--components--<c>) may."
		fi
		;;
	*) deny "PR #$pr merges \`${head:-?}\` into \`$base\`. Only dev → staging and staging → main are promotions." ;;
	esac
	require_merge_flags
	if [ "$kind" = release ]; then
		# @mut release-rule
		require_release_pr
	fi
	# @mut merge-green
	require_green
	exit 0
}

# require_merge_flags — the promotion merge shape, for a promotion or a release PR (reads main's
# locals): --merge, never --squash/--rebase/--auto/--delete-branch, and --match-head-commit = head.
require_merge_flags() {
	if [ "$squash" = 1 ] || [ "$rebase" = 1 ]; then
		deny "$kind PR #$pr must land as a merge commit (--merge); a squash or rebase drops the ancestry the next promotion needs."
	fi
	[ "$merge" = 1 ] || deny "$kind PR #$pr must say --merge explicitly (a merge commit, not a squash)."
	if [ "$auto" = 1 ]; then
		deny "\`--auto\` on $kind PR #$pr would land it later, on whatever $base requires then — not on the state this guard checks. Merge it once it is green."
	fi
	if [ "$delbranch" = 1 ]; then
		# @mut merge-delete-branch
		deny "\`--delete-branch\` on $kind PR #$pr would delete \`$head\` — for a promotion, the integration branch itself."
	fi
	[ -n "$sha" ] || deny "could not read the head commit of $kind PR #$pr, so the checks cannot be tied to what lands."
	local exact="gh pr merge $pr${repo:+ -R $repo} --merge --match-head-commit $sha"
	if [ -z "$mhc" ]; then
		# @mut merge-mhc-missing
		deny "$kind PR #$pr must name the head its checks were verified for. Run:  $exact"
	fi
	if [ "$mhc" != "$sha" ]; then
		# @mut merge-mhc-mismatch
		deny "$kind PR #$pr: --match-head-commit $mhc is not its head ($sha) — the head moved, and the new one is what the checks below describe. Re-check, then run:  $exact"
	fi
}

# release_allowlist — print the files a release PR may change, derived from
# release-please-config.json: the manifest, each package's changelog-path and its extra-files
# (relative to the package, or to the repo root when written with a leading `/`).
release_allowlist() {
	local cfg="${CLAUDE_PROJECT_DIR:-.}/release-please-config.json"
	echo ".release-please-manifest.json"
	jq -r '(.["changelog-path"] // "CHANGELOG.md") as $dcl
		| .packages // {} | to_entries[]
		| (if .key == "." then "" else .key + "/" end) as $p
		| ($p + (.value["changelog-path"] // $dcl)),
		  ((.value["extra-files"] // [])[] | (if type == "string" then . else .path end)
		   | select(type == "string") | if startswith("/") then ltrimstr("/") else $p + . end)' \
		"$cfg" 2>/dev/null
}

# require_release_pr — a release PR's author is the release automation, and it changes only the
# files release-please writes. Both are read from the API (reads main's locals).
require_release_pr() {
	local info allowed bad
	info="$(gh pr view "$pr" "${rargs[@]}" --json author,files,changedFiles 2>/dev/null)"
	printf '%s' "$info" | jq -e 'type == "object" and (.files | type == "array")' >/dev/null 2>&1 ||
		deny "could not read the author and files of release PR #$pr (offline, or gh failed)."
	if ! printf '%s' "$info" | jq -e --arg a "$RELEASE_AUTHOR" '.author.login == $a' >/dev/null 2>&1; then
		# @mut release-author
		deny "release PR #$pr was not opened by \`$RELEASE_AUTHOR\` (it was by \`$(printf '%s' "$info" | jq -r '.author.login // "?"')\`) — only release-please's own PR merges this way."
	fi
	if ! printf '%s' "$info" | jq -e '(.files | length) == .changedFiles' >/dev/null 2>&1; then
		# @mut release-filecount
		deny "release PR #$pr: the file list gh returned does not cover all $(printf '%s' "$info" | jq -r '.changedFiles') changed files, so it cannot be shown to carry only release files."
	fi
	allowed="$(release_allowlist)"
	bad="$(printf '%s' "$info" | jq -r --arg ok "$allowed" '
		($ok | split("\n") | map(select(length > 0))) as $ok
		| [.files[] | .path as $p | select(any($ok[]; . == $p) | not) | $p] | join(", ")')"
	if [ -n "$bad" ]; then
		# @mut release-files
		deny "release PR #$pr changes files release-please does not write: $bad."
	fi
	bad="$(printf '%s' "$info" | jq -r '[.files[] | select(.changeType != "MODIFIED" and .changeType != "ADDED") | "\(.path) (\(.changeType))"] | join(", ")')"
	if [ -n "$bad" ]; then
		# @mut release-changetype
		deny "release PR #$pr renames or deletes a file: $bad."
	fi
}

# require_green — every check passed and every release-gate leg passed for the PR's head (reads
# main's locals). The one copy, for a promotion and a release PR alike.
require_green() {
	# gh exits 8 while checks are pending and 1 when one failed, printing the JSON either way, so
	# the exit code is not the signal: the JSON is, and an unparseable answer fails closed.
	local checks notgreen gate_yml legs missing
	checks="$(gh pr checks "$pr" "${rargs[@]}" --json name,bucket,workflow 2>/dev/null)"
	printf '%s' "$checks" | jq -e 'type == "array"' >/dev/null 2>&1 ||
		deny "could not read the checks of $kind PR #$pr (offline, or gh failed)."
	# Subsumed by the leg check below (an empty list has no passing leg) — kept for the message.
	printf '%s' "$checks" | jq -e 'length > 0' >/dev/null 2>&1 ||
		deny "$kind PR #$pr reports no checks at all — nothing has proven it green."

	notgreen="$(printf '%s' "$checks" | jq -r '[.[] | select(.bucket != "pass" and .bucket != "skipping") | "\(.name) (\(.bucket))"] | join(", ")')"
	if [ -n "$notgreen" ]; then
		# @mut merge-notgreen
		deny "$kind PR #$pr is not green: $notgreen."
	fi

	# Every release-gate leg the gate's own table names must have PASSED (skipping is not
	# passing), and so must any extra `Release gate (…)` check the PR carries.
	gate_yml="${CLAUDE_PROJECT_DIR:-.}/.github/workflows/release-gate.yml"
	legs="$(grep -oE '\{[[:space:]]*project:[[:space:]]*"[^"]+"' "$gate_yml" 2>/dev/null | sed -E 's/.*"([^"]+)"/\1/')"
	[ -n "$legs" ] || deny "could not read the release-gate legs from $gate_yml, so PR #$pr cannot be shown green."
	# The ONE exemption: a run whose gate job's `if:` was false never expands its matrix, so it
	# reports a single SKIPPED check named with the literal expression (release-gate.yml says so at
	# the job). It names no leg, and every named leg above must still have passed on its own — so a
	# skipped placeholder proves nothing either way. A FAILING or PENDING placeholder is refused by
	# the not-green check above, not here; this clause only keeps the exemption to `skipping`.
	# @mut merge-placeholder
	placeholder='Release gate (${{ matrix.project }})'
	missing="$(printf '%s' "$checks" | jq -r --arg legs "$legs" --arg placeholder "$placeholder" '
		. as $c
		| ($legs | split("\n") | map(select(length > 0)) | map("Release gate (\(.))")) as $want
		| ([$want[] | . as $n | select(([$c[] | select(.name == $n and .bucket == "pass")] | length) == 0)]
		   + [$c[] | select((.name | startswith("Release gate (")) and .bucket != "pass")
		     | select((.name == $placeholder and .bucket == "skipping") | not) | .name])
		| unique | join(", ")')"
	if [ -n "$missing" ]; then
		# @mut merge-legs
		deny "$kind PR #$pr: these release-gate legs have not passed: $missing."
	fi
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
	cat >"$stub/root/release-please-config.json" <<'JSON'
{ "packages": {
    "apps/cli": { "release-type": "simple", "component": "cli", "changelog-path": "CHANGELOG.md" },
    "apps/runner": { "component": "runner",
      "extra-files": [ "internal/version.txt", { "type": "generic", "path": "/deploy/runner-version.yaml" } ] } } }
JSON
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
1621	[$C,$G,$Q,{"name":"Release gate (\${{ matrix.project }})","bucket":"skipping","workflow":"Release gate"}]
1622	[$C,$G,$Q,{"name":"Release gate (\${{ matrix.project }})","bucket":"fail","workflow":"Release gate"}]
1623	[$C,$G,{"name":"Release gate (\${{ matrix.project }})","bucket":"skipping","workflow":"Release gate"}]
1624	[$C,$G,$Q,{"name":"Release gate (canvas)","bucket":"skipping","workflow":"Release gate"}]
1700	[$C,$G,$Q]
1800	[$C,$S,$G,$Q]
1801	[$C,$G,$Q]
1802	[$C,$G,$Q]
1803	[$C,$G,$Q]
1804	[$C,$G,$Q]
1805	[$C,$G,$Q]
1806	[$C,$G,$Q]
1807	[$C,$G,$Q]
1808	[{"name":"CI / Build","bucket":"fail","workflow":"CI"},$G,$Q]
1809	[{"name":"CI / Build","bucket":"pending","workflow":"CI"},$G,$Q]
1810	[$C,$G,$Q]
1811	[$C,$G,$Q]
1812	[$C,$G,$Q]
1813	[$C,$G,$Q]
1814	[$C,$G,$Q]
1815	[$C,$G]
EOF
	# Release PRs: `gh pr view N --json author,files,changedFiles` prints that PR's row (1813: the
	# lookup fails). A is the release automation, M/L a release PR's two ordinary files.
	local A M L
	A='"author":{"is_bot":true,"login":"app/alethia-labs-ci"}'
	M='{"path":".release-please-manifest.json","changeType":"MODIFIED"}'
	L='{"path":"apps/cli/CHANGELOG.md","changeType":"MODIFIED"}'
	cat >"$stub/release.tsv" <<EOF
1800	{$A,"changedFiles":2,"files":[$M,$L]}
1801	{"author":{"is_bot":false,"login":"alethia-labs-ci"},"changedFiles":2,"files":[$M,$L]}
1802	{$A,"changedFiles":2,"files":[$M,$L]}
1803	{$A,"changedFiles":2,"files":[$M,$L]}
1804	{$A,"changedFiles":2,"files":[$M,$L]}
1805	{$A,"changedFiles":3,"files":[$M,$L,{"path":"apps/cli/main.go","changeType":"MODIFIED"}]}
1806	{$A,"changedFiles":3,"files":[$M,$L]}
1807	{$A,"changedFiles":2,"files":[$M,{"path":"apps/cli/CHANGELOG.md","changeType":"RENAMED"}]}
1808	{$A,"changedFiles":2,"files":[$M,$L]}
1809	{$A,"changedFiles":2,"files":[$M,$L]}
1810	{$A,"changedFiles":2,"files":[$M,$L]}
1811	{$A,"changedFiles":4,"files":[$M,{"path":"apps/runner/CHANGELOG.md","changeType":"MODIFIED"},{"path":"apps/runner/internal/version.txt","changeType":"MODIFIED"},{"path":"deploy/runner-version.yaml","changeType":"ADDED"}]}
1812	{$A,"changedFiles":2,"files":[$M,{"path":"apps/cli/sub/CHANGELOG.md","changeType":"MODIFIED"}]}
1814	{$A,"changedFiles":2,"files":[$M,{"path":"release-please-config.json","changeType":"MODIFIED"}]}
1815	{$A,"changedFiles":2,"files":[$M,$L]}
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
if [ "\$2" = view ] && [[ "\$*" == *author* ]]; then
	[ "\$n" = 1813 ] && exit 1
	line="\$(grep "^\$n	" "$stub/release.tsv")" || exit 1
	printf '%s\n' "\${line#*	}"
	exit 0
fi
if [ "\$2" = view ]; then
	R=release-please--branches--main--components--
	case "\$n" in
	1800 | 1801 | 1805 | 1806 | 1807 | 1808 | 1809 | 1812 | 1813 | 1814 | 1815) echo "main \${R}cli aaa\$n" ;;
	1802) echo "main \${R}cli/evil aaa1802" ;;
	1803) echo "main x\${R}cli aaa1803" ;;
	1804) echo "main release-please--branches--staging--components--cli aaa1804" ;;
	1810) echo "staging \${R}cli aaa1810" ;;
	1811) echo "main \${R}runner aaa1811" ;;
	1535) echo "dev feat/x 1535aaa" ;;
	1600) echo "staging feat/x 1600aaa" ;;
	1601) echo "main feat/x 1601aaa" ;;
	1610 | 1612 | 1613 | 1614 | 1615 | 1616 | 1618 | 1619 | 1620 | 1621 | 1622 | 1623 | 1624) echo "staging dev aaa\$n" ;;
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
	t allow 'gh pr merge 1621 --merge --match-head-commit aaa1621'   # a SKIPPED unexpanded-matrix placeholder beside green legs
	t block 'gh pr merge 1622 --merge --match-head-commit aaa1622'   # the placeholder FAILING still blocks
	t block 'gh pr merge 1623 --merge --match-head-commit aaa1623'   # a skipped placeholder never stands in for a missing leg
	t block 'gh pr merge 1624 --merge --match-head-commit aaa1624'   # the exemption is that ONE name: any other skipped gate leg still blocks

	# ── release-please PRs into main (maintainer ruling 2026-11-11) ──
	t allow 'gh pr merge 1800 --merge --match-head-commit aaa1800'   # green, release-please's author and files
	t allow 'gh pr merge 1811 --merge --match-head-commit aaa1811'   # changelog + extra-files, from the config
	t block 'gh pr merge 1801 --merge --match-head-commit aaa1801'   # a look-alike author
	says "was not opened by \`app/alethia-labs-ci\`" 'the wrong author is named'
	t block 'gh pr merge 1802 --merge --match-head-commit aaa1802'   # the branch only STARTS right
	says 'Only staging → main and a release-please PR' 'a look-alike branch is refused as a branch'
	t block 'gh pr merge 1803 --merge --match-head-commit aaa1803'   # the branch only ENDS right
	t block 'gh pr merge 1804 --merge --match-head-commit aaa1804'   # release branch for another base
	t block 'gh pr merge 1805 --merge --match-head-commit aaa1805'   # also changes a code file
	says 'apps/cli/main.go' 'the code file is named'
	t block 'gh pr merge 1806 --merge --match-head-commit aaa1806'   # gh listed fewer files than changed
	t block 'gh pr merge 1807 --merge --match-head-commit aaa1807'   # a rename onto an allowed path
	t block 'gh pr merge 1808 --merge --match-head-commit aaa1808'   # a failed check
	t block 'gh pr merge 1809 --merge --match-head-commit aaa1809'   # a pending check
	says 'is not green' 'the pending check is named'
	t block 'gh pr merge 1810 --merge --match-head-commit aaa1810'   # base staging
	t block 'gh pr merge 1812 --merge --match-head-commit aaa1812'   # a CHANGELOG.md no package names
	t block 'gh pr merge 1813 --merge --match-head-commit aaa1813'   # author/files lookup failed
	t block 'gh pr merge 1814 --merge --match-head-commit aaa1814'   # edits release-please-config.json
	t block 'gh pr merge 1815 --merge --match-head-commit aaa1815'   # a release-gate leg never reported
	t block 'gh pr merge 1800 --merge'                               # no --match-head-commit
	says 'gh pr merge 1800 --merge --match-head-commit aaa1800' 'the release refusal names the exact command'
	t block 'gh pr merge 1800 --merge --match-head-commit bbb999'    # mismatched head
	t block 'gh pr merge 1800 --squash --match-head-commit aaa1800'
	t block 'gh pr merge 1800 --rebase --match-head-commit aaa1800'
	t block 'gh pr merge 1800 --match-head-commit aaa1800'           # no --merge
	t block 'gh pr merge 1800 --merge --auto --match-head-commit aaa1800'
	t block 'gh pr merge 1800 --merge --admin --match-head-commit aaa1800'
	t block 'gh pr merge 1800 --merge --delete-branch --match-head-commit aaa1800'
	t block 'gh pr merge 1800 --merge --match-head-commit aaa1800 && gh pr merge 1811 --merge --match-head-commit aaa1811'

	# ── gh's global flags before the subcommand, and the repository they name ──
	t block 'gh -R o/r pr merge 1601 --merge'
	t block 'gh --repo o/r pr merge 1612 --merge --match-head-commit aaa1612'
	t allow 'gh -R o/r pr merge 1535 --squash'
	t allow 'gh -R o/other pr merge 1700 --merge --match-head-commit aaa1700'
	t allow 'gh pr merge 1700 --merge --match-head-commit aaa1700 -R o/other'
	t block 'gh pr merge 1700 --merge --match-head-commit aaa1700'   # not in the cwd's repo → unresolvable

	# ── the PR is the first POSITIONAL word; a number inside an option value is not it ──
	t allow 'gh pr merge --merge --subject "release 1535" --match-head-commit aaa1610 1610'
	t block 'gh pr merge --merge --body "fixes 1535" 1601'      # 1601 (main ← feature) is what merges
	says 'PR #1601' 'the PR checked is the positional one'
	t block 'gh pr merge --merge -t "promote 1535 now" 1612 --match-head-commit aaa1612'
	t allow "gh pr merge 1535 --squash --body 'done; see #1601'"
	t block 'gh pr merge feat/some-branch --merge'               # a branch name, not a PR
	says 'is not a PR number or URL' 'a non-number selector is named'

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

	# The real release-please-config.json must yield the CLI's changelog, or every release PR would
	# fail closed.
	if [ -f "$(dirname "$real")/../../release-please-config.json" ]; then
		if CLAUDE_PROJECT_DIR="$(cd "$(dirname "$real")/../.." && pwd)" release_allowlist | grep -qx 'apps/cli/CHANGELOG.md'; then
			pass=$((pass + 1))
		else
			fail=$((fail + 1))
			echo "  ✗ apps/cli/CHANGELOG.md does not derive from the real release-please-config.json"
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
