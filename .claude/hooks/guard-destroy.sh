#!/usr/bin/env bash
# PreToolUse(Bash) guard: nothing an agent runs becomes UNRECOVERABLE.
#
# The maintainer delegated everything to the agents except two things: spend beyond a budget
# (.claude/hooks/guard-spend.sh) and irreversible deletion (this file). A hook blocks in every
# permission mode, so this is the layer that holds when the classifier half (user settings) is
# relaxed or wrong.
#
# TWO KINDS OF RULE
#
#   REFUSE (exit 2) — the deletion cannot be undone from this machine:
#     R-PUSH     a push to, or delete of, dev/staging/main in any refspec form; --mirror;
#                --all/--branches with force; deleting a remote tag in any spelling (a delete
#                whose target is not a KNOWN branch is treated as a tag); --prune together with
#                --tags, --all or a tags refspec; --prune-tags; force-pushing --tags; pushing
#                refs/safety/* anywhere (snapshots can hold untracked private files)
#     R-GH       gh repo delete|archive|rename, gh repo edit --visibility, gh release
#                delete|delete-asset, gh secret delete|remove, gh issue delete
#     R-GHAPI    gh api DELETE|PUT|PATCH on rulesets, branch protection, releases, git/refs,
#                packages, environments, hooks, actions/dependabot/codespaces secrets, tag
#                protection, or the repo/org itself; POST to /transfer or a branch rename;
#                a graphql mutation that deletes or rewrites one of those
#     R-TFSTATE  removing or overwriting a terraform.tfstate* (rm/mv/cp-onto/truncate/shred/`>`),
#                rm -r of a directory holding one, `git clean -x|-X` in a tree that holds one,
#                `git worktree remove` (forced or not) of a tree holding one, `find … -delete` /
#                `find -exec rm` that can reach one, `rsync --delete` onto a directory holding one,
#                tofu|terraform state rm|mv|push|replace-provider, init -migrate-state|-force-copy,
#                workspace delete. infra/{gcp,azure,alibaba}-e2e and infra/sandbox keep LOCAL,
#                gitignored state: no snapshot below can see an ignored file, so this refuses.
#     R-DB       db:reset / db:migrate / db:reencrypt / drizzle-kit push|drop|migrate / the
#                reset|migrate scripts against a NON-LOCAL ALETHIA_DATABASE_URL, or one the guard
#                cannot read. apps/console/scripts/reset.mjs runs DROP SCHEMA public CASCADE with
#                no localhost check of its own.
#     R-DOCKER   docker volume prune; docker volume rm / docker rm -v naming an alethia volume or
#                container; docker system prune --volumes
#     R-CLOUD    cloud deletes outside a disposable target: hcloud delete|rebuild without
#                --context alethia-e2e|alethia-sandbox; any aws/gcloud/az/aliyun delete verb;
#                kubectl delete|drain|replace --force|apply --prune and helm uninstall outside a
#                kind-* or *-e2e* context
#     R-CRED     rm/mv/shred/truncate/`>` of ~/.aws ~/.ssh ~/.config/gcloud ~/.cloudflared
#                ~/.kube ~/.config/hcloud, or of any directory that contains one
#     R-GITDIR   rm of the repository's .git directory, or of any directory that contains it
#                (the safety refs below live there, so this one has nothing to fall back on)
#
#   SNAPSHOT, THEN ALLOW (exit 0) — local git destruction, made recoverable with no friction:
#     S-TREE     git reset --hard · git clean (not -n) · git checkout (any form but -b/-B/--orphan)
#                · git switch -f|--discard-changes · git restore · git rm -f · rm of a path inside
#                a git work tree
#     S-WTREE    git worktree remove --force <path>
#     S-STASH    git stash drop|clear — pins the entries it would drop
#     S-BRANCH   git branch -D / --delete --force — pins the tips it would drop
#
#   A snapshot captures the tree's tracked AND untracked non-ignored content: copy the real index
#   to a temp GIT_INDEX_FILE (so unchanged files are not re-hashed), `git add -u` for the tracked
#   changes, then the untracked files UP TO A CAP, `write-tree`, `commit-tree` with HEAD as parent,
#   and store it at
#       refs/safety/<worktree-name>/<UTC timestamp>
#   Objects and refs/safety/* live in the SHARED repository, so they outlive the worktree's own
#   deletion. Nothing is stored when the tree already equals HEAD. session-cleanup.sh prunes
#   refs/safety entries older than 30 days.
#
#   THE SNAPSHOT IS BOUNDED, so it can never stall a command, AND FAIR, so one big directory cannot
#   starve a small real file. Tracked changes are ALWAYS captured, whatever their path. Untracked
#   dependency caches are never captured (.pnpm-store, node_modules, .yarn/cache, .npm, .venv,
#   .terraform, .gradle — all re-downloadable; the main checkout once held a 1.7 GB / 128k-file
#   .pnpm-store that made one snapshot take 95 s and write 864 MB). The untracked budget is
#   SNAP_MAX_FILES (5000) and SNAP_MAX_BYTES (50 MB), spent in this order:
#     1. `git ls-files -o --directory` lists untracked entries with every wholly-untracked
#        directory collapsed to ONE line, so the listing is cheap however big a directory is;
#     2. loose untracked files (new files inside tracked directories) go first, SMALLEST first;
#     3. each collapsed directory then gets an equal share of what is left, and is read only up to
#        that share (at most SNAP_MAX_DIRS (50) directories; the listing itself stops at
#        SNAP_SCAN_MAX (20000) entries).
#   Why those numbers: a branch's real untracked work is tens to hundreds of files and a few MB;
#   5000 files / 50 MB hashes in well under a second and stores at most 50 MB per snapshot, while
#   still covering a large generated fixture set. Anything over budget is LEFT OUT, never waited
#   for, and a one-line warning names EVERY group left out: each directory cut at its share, each
#   file group over the byte cap, each directory not scanned, and where a listing stopped.
#
#   RESTORE (also in .claude/skills/dev/SKILL.md → "Recovering from a destructive command"):
#       git for-each-ref --sort=-refname refs/safety/            # what is there
#       git show --stat <ref>     ·    git diff <ref>^ <ref>       # what it saved
#       git restore --source=<ref> --worktree -- <path>…          # put files back
#       git worktree add ../wt-recovered <ref>^                   # a removed tree: its HEAD …
#       git -C ../wt-recovered restore --source=<ref> --worktree -- .   # … then its files
#       git stash store -m recovered <ref>                        # a -stash-N pin only
#       git branch <name> <ref>                                   # a -branch-<name> pin only
#   A tree snapshot is restored as FILES onto a normal commit, never checked out as a branch or a
#   worktree base: its commit carries every untracked file it captured, and this repo is public.
#   (A -stash-N or -branch-<name> pin is the original commit, not a snapshot, so those two are safe.)
#
# BOUNDARIES — what this deliberately does NOT catch (the classifier half's job, or not text):
#   · anything inside a script file (`bash x.sh`), an alias, a function, or text built at run
#     time (`eval`, `$(…)` that PRODUCES a command). Variables are not expanded except $HOME/~.
#   · an rm whose target is an unexpanded variable is snapshotted as "the cwd's tree" (best
#     effort) and allowed — `rm -rf "$tmp"` is too common to refuse. A git command whose TREE is
#     an unexpanded variable (`git -C "$W" reset --hard`) is refused: it cannot be snapshotted.
#   · ignored files (.env, node_modules, build output) are never in a snapshot; only tfstate,
#     which has no other copy, is refused outright.
#   · `git reflog expire`, `git gc --prune=now`, `git update-ref -d`, `git branch -M` overwriting
#     a branch, `git filter-repo`: local history surgery, rare, not matched.
#   · psql/SQL text run against a remote database; DB URLs set in a shell profile the hook
#     process does not inherit.
#   · `docker rm -v` of a container not named alethia* (it only removes ANONYMOUS volumes; the
#     compose stack's named volumes survive it).
#   · gh api calls whose path or method is in a variable are refused only when the path is
#     recognisably protected.
#
# There is NO escape hatch here, on purpose: an irreversible action is the maintainer's to run.
#
# CRASH DIRECTION IS FAIL-OPEN, deliberately: a crash (exit other than 0/2) is an allow, because no
# hook sets `onFailure: "block"` and a guard bug must never brick every Bash call. The REFUSALS
# above are explicit exits, never a crash. Without jq the command cannot be read and this hook
# allows (the spend guard refuses priced commands in that case; this one does not, because "git"
# appearing in a command is not evidence of destruction).
#
# gh's global flags before the subcommand are parsed by lib/cmdline.sh. The deny rules in
# .claude/settings.json are prefix matches and cannot see past such flags; this hook can.

_self="${BASH_SOURCE[0]}"
case "$_self" in */*) HOOK_DIR="${_self%/*}" ;; *) HOOK_DIR="." ;; esac
# shellcheck source=lib/cmdline.sh
. "$HOOK_DIR/lib/cmdline.sh"

refuse() { # <rule-id> <what> [why]
	{
		echo "BLOCKED (guard-destroy ${1}): ${2}"
		if [ -n "${3:-}" ]; then
			echo ""
			echo "  ${3}"
		fi
		echo ""
		echo "  This cannot be undone from here, so it is not an agent's call: ask the maintainer."
	} >&2
	exit 2
}

note() { echo "guard-destroy: $*" >&2; }

# xp <word> — sets X: the word with variables assigned earlier in this command expanded, or the
# word unchanged when one is left unresolved (cmdline_has_var then still sees it).
xp() {
	if cmdline_expand "$1"; then X="$EXPANDED"; else X="$1"; fi
}

is_protected_branch() {
	case "$1" in dev | staging | main) return 0 ;; esac
	return 1
}

# ── path helpers ──────────────────────────────────────────────────────────────────────────────
# path_overlaps <p> <q> — is p the same as q, inside q, or an ancestor of q? p may be a glob.
path_overlaps() {
	local p="$1" q="$2"
	[ "$p" = "$q" ] && return 0
	case "$p" in "$q"/*) return 0 ;; esac
	case "$q" in "$p"/*) return 0 ;; esac
	[ "$p" = "/" ] && return 0
	case "$p" in
	*[\*\?\[]*)
		# shellcheck disable=SC2254
		case "$q" in $p | $p/*) return 0 ;; esac
		;;
	esac
	return 1
}

cred_paths() {
	CREDS=("$HOME/.aws" "$HOME/.ssh" "$HOME/.config/gcloud" "$HOME/.cloudflared" "$HOME/.kube" "$HOME/.config/hcloud")
}

# The shared repository's .git — the thing the safety refs live in.
common_git_dir() {
	COMMON_GIT=""
	local root="${CLAUDE_PROJECT_DIR:-}"
	[ -n "$root" ] && [ -d "$root/.git" ] && COMMON_GIT="$root/.git"
}

# find_top <path> — walk up to the nearest directory holding a `.git` (dir or file). Pure bash,
# so an rm under /tmp costs no fork. Sets TOP; fails when the path is in no git tree.
find_top() {
	local d="$1"
	[ -d "$d" ] || d="${d%/*}"
	while [ -n "$d" ]; do
		if [ -e "$d/.git" ]; then
			TOP="$d"
			return 0
		fi
		[ "$d" = "/" ] && break
		d="${d%/*}"
		[ -n "$d" ] || d="/"
	done
	return 1
}

tree_has_tfstate() { # <top>
	compgen -G "$1/*.tfstate*" >/dev/null ||
		compgen -G "$1/*/*.tfstate*" >/dev/null ||
		compgen -G "$1/*/*/*.tfstate*" >/dev/null ||
		compgen -G "$1/*/*/*/*.tfstate*" >/dev/null
}

is_tfstate_path() {
	case "$1" in *.tfstate | *.tfstate.* | *terraform.tfstate*) return 0 ;; esac
	return 1
}

# ── the snapshot ──────────────────────────────────────────────────────────────────────────────
# The identity every snapshot commit is written with. .githooks/pre-push refuses any pushed commit
# carrying it, and rule_push refuses a source whose unpushed history carries it.
SNAP_EMAIL=safety@alethia.invalid
# @mut-sub snap-file-cap s/5000/9999999/
SNAP_MAX_FILES=5000
# @mut-sub snap-byte-cap s/50 \* 1024 \* 1024/50 * 1024 * 1024 * 1024/
SNAP_MAX_BYTES=$((50 * 1024 * 1024))
# @mut-sub snap-scan-cap s/20000/9999999/
SNAP_SCAN_MAX=20000
SNAP_MAX_DIRS=50

# The untracked-file selector, run with the tree as its cwd. Arguments: <out-list> <max-files>
# <max-bytes> <max-dirs> <scan-max> <n-specs> <spec>… <exclude>…. Writes the chosen paths to
# <out-list> (NUL-separated) and prints "<taken> <left> <left-bytes> <groups>", where <groups> names
# every group left out. Every `git ls-files` it starts is read only as far as it needs, and closing
# the pipe stops git.
SNAP_SELECT_PL='
use strict; use warnings;
my ($out, $maxf, $maxb, $maxdirs, $scan, $ns, @r) = @ARGV;
my @specs = @r[0 .. $ns - 1];
my @ex = @r[$ns .. $#r];
# The untracked dependency caches, never captured. One list, applied to every listed entry,
# including a whole directory `--directory` collapsed to one line.
# @mut-sub snap-exclude-store s/\\.pnpm-store\|//
my $cache = qr{(^|/)(\.pnpm-store|node_modules|\.yarn/cache|\.npm|\.venv|\.terraform|\.gradle)(/|$)};
sub walk {
	my ($lim, $dirmode, @paths) = @_;
	my @cmd = ("git", "ls-files", "-o", "--exclude-standard", "-z");
	push @cmd, "--directory", "--no-empty-directory" if $dirmode;
	my (@got, $more);
	$more = 0;
	open(my $h, "-|", @cmd, "--", @paths, @ex) or return (\@got, 0);
	local $/ = "\0";
	while (my $p = <$h>) {
		chomp $p;
		next if $p =~ $cache;
		if (@got >= $lim) { $more = 1; last; }
		push @got, $p;
	}
	close $h;
	return (\@got, $more);
}
my %sz;
sub size { my $p = shift; $sz{$p} //= (-s $p) // 0; return $sz{$p}; }
my ($ent, $emore) = walk($scan, 1, @specs);
my (@loose, @dirs);
for (@$ent) { if (m{/$}) { push @dirs, $_ } else { push @loose, $_ } }
my ($an, $ab, $ln, $lb) = (0, 0, 0, 0);
my (@take, %grp);
sub try_take {
	my ($p, $g, $why) = @_;
	my $s = size($p);
	if ($an < $maxf && $ab + $s <= $maxb) { push @take, $p; $an++; $ab += $s; return 1; }
	$ln++; $lb += $s; $grp{$g} //= $why; return 0;
}
# 2. loose files, smallest first
# @mut-sub snap-small-first s/^/#/
@loose = sort { size($a) <=> size($b) || $a cmp $b } @loose;
for my $p (@loose) {
	my ($t) = $p =~ m{^([^/]+/)};
	try_take($p, defined $t ? "$t (loose files)" : $p, "over the cap");
}
# 3. directories: an equal share each
my @scan_dirs = @dirs;
if (@scan_dirs > $maxdirs) {
	# @mut-sub snap-name-unscanned s/^/#/
	$grp{$_} = "not scanned: over the $maxdirs-directory limit" for @scan_dirs[$maxdirs .. $#scan_dirs];
	@scan_dirs = @scan_dirs[0 .. $maxdirs - 1];
}
my $n = scalar @scan_dirs;
my $left_f = $maxf - $an;
$left_f = 0 if $left_f < 0;
# @mut-sub snap-fair-share s/int\(\$left_f \/ \$n\)/\$left_f/
my $share = $n ? int($left_f / $n) : 0;
$share = 1 if $n && $share < 1;
for my $d (@scan_dirs) {
	my ($got, $more) = walk($share, 0, $d);
	try_take($_, $d, "over the cap") for @$got;
	if ($more) {
		# @mut-sub snap-name-cut s/^/#/
		$grp{$d} = "cut at its share of " . scalar(@$got) . " files; the rest were not read";
	}
}
# @mut-sub snap-name-stop s/^/#/
$grp{"everything listed after " . $ent->[-1]} = "not seen: the listing stopped at $scan entries" if $emore;
open(my $o, ">", $out) or die;
print $o "$_\0" for @take;
close $o;
print join(" ", $an, $ln, $lb, (%grp ? join("; ", map { "$_ ($grp{$_})" } sort keys %grp) : "-")), "\n";
'

safety_ts() { SAFETY_TS="$(date -u +%Y%m%dT%H%M%SZ)"; }

# store_ref <top> <name-suffix> <commit> — create refs/safety/<wt>/<ts><suffix>, never overwrite.
store_ref() {
	local top="$1" suffix="$2" commit="$3" name ref
	name="${top##*/}"
	name="${name//[^A-Za-z0-9._-]/_}"
	[ -n "${SAFETY_TS:-}" ] || safety_ts
	ref="refs/safety/$name/$SAFETY_TS$suffix"
	if ! git -C "$top" update-ref "$ref" "$commit" "" 2>/dev/null; then
		ref="$ref-$$-${RANDOM}"
		git -C "$top" update-ref "$ref" "$commit" "" 2>/dev/null || return 1
	fi
	STORED_REF="$ref"
}

# snapshot_tree <top> <label> [pathspec…] — save tracked + untracked non-ignored content.
snapshot_tree() {
	local top="$1" label="$2" info gd head="" base="" tmp tree commit
	shift 2
	local l3="" l4=""
	info="$(git -C "$top" rev-parse --show-toplevel --absolute-git-dir HEAD 'HEAD^{tree}' 2>/dev/null)"
	top=""
	gd=""
	{
		IFS= read -r top
		IFS= read -r gd
		IFS= read -r l3
		IFS= read -r l4
	} <<<"$info"
	case "$l3" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
		head="$l3"
		base="$l4"
		;;
	esac
	[ -n "$top" ] && [ -n "$gd" ] || return 2
	tmp="$(mktemp "${TMPDIR:-/tmp}/alethia-safety-index.XXXXXX")" || return 2
	if [ -f "$gd/index" ]; then cp "$gd/index" "$tmp"; else rm -f "$tmp"; fi
	[ $# -gt 0 ] || set -- ":/"
	# add's exit code is not the signal: an explicitly named IGNORED path makes it exit 1 having
	# done exactly the right thing. write-tree is the signal.
	# 1. tracked changes, ALL of them, whatever their path — bounded by the index, which already
	#    knows every tracked file. The cache excludes are for UNTRACKED content only.
	# @mut-sub snap-tracked-all s/-- "\$@" >/-- "\$@" ":(exclude,glob)**\/node_modules\/**" >/
	GIT_INDEX_FILE="$tmp" git -C "$top" add -u -- "$@" >/dev/null 2>&1
	# 2. untracked files, within the budget, fairly (see the header)
	local list stats taken=0 left=0 lbytes=0 groups=-
	list="$(mktemp "${TMPDIR:-/tmp}/alethia-safety-list.XXXXXX")" || {
		rm -f "$tmp"
		return 2
	}
	stats="$(cd "$top" && perl -e "$SNAP_SELECT_PL" "$list" "$SNAP_MAX_FILES" "$SNAP_MAX_BYTES" "$SNAP_MAX_DIRS" "$SNAP_SCAN_MAX" "$#" "$@" 2>/dev/null)"
	read -r taken left lbytes groups <<<"$stats"
	case "$taken" in '' | *[!0-9]*) taken=0 ;; esac
	if [ "$taken" -gt 0 ]; then
		GIT_INDEX_FILE="$tmp" GIT_LITERAL_PATHSPECS=1 git -C "$top" add --pathspec-from-file="$list" --pathspec-file-nul >/dev/null 2>&1
	fi
	rm -f "$list"
	if [ -n "$groups" ] && [ "$groups" != - ]; then
		local counted=""
		[ "${left:-0}" -gt 0 ] 2>/dev/null && counted=", ${left} file(s) / $((${lbytes:-0} / 1048576)) MB of it counted"
		note "snapshot LEFT OUT untracked content over the ${SNAP_MAX_FILES}-file / $((SNAP_MAX_BYTES / 1048576)) MB budget${counted} — not captured: ${groups}"
	fi
	tree="$(GIT_INDEX_FILE="$tmp" git -C "$top" write-tree 2>/dev/null)"
	rm -f "$tmp"
	[ -n "$tree" ] || return 2
	if [ -n "$base" ] && [ "$tree" = "$base" ]; then
		STORED_REF=""
		return 0
	fi
	commit="$(printf 'safety snapshot before: %s\n\ntree: %s\n' "$label" "$top" |
		git -C "$top" -c user.name=alethia-safety -c user.email="$SNAP_EMAIL" \
			commit-tree "$tree" ${head:+-p "$head"} 2>/dev/null)"
	[ -n "$commit" ] || return 2
	store_ref "$top" "" "$commit" || return 2
	note "saved the tree before \`$label\` → $STORED_REF   (restore: git restore --source=$STORED_REF --worktree -- <path>)"
}

# snap <rule-id> <dir> <label> [pathspec…] — snapshot the git tree holding <dir>, or refuse when
# the tree cannot be known or the snapshot fails. Not in a git tree: nothing of git's to lose.
snap() {
	local id="$1" dir="$2" label="$3"
	shift 3
	if [ -z "$dir" ]; then
		refuse "$id" "cannot tell which tree \`$label\` changes, so it cannot be snapshotted first." \
			"Spell the path literally (no unexpanded \$VAR, no \`cd -\`) and run it again — the guard then saves the tree to refs/safety/ and lets it through."
	fi
	find_top "$dir" || return 0
	snapshot "$id" "$TOP" "$label" "$@"
}

# snapshot <rule-id> <top> <label> [pathspec…] — snapshot_tree, refusing when it fails.
snapshot() {
	local id="$1" top="$2" label="$3"
	shift 3
	snapshot_tree "$top" "$label" "$@" ||
		refuse "$id" "could not snapshot $top before \`$label\`." \
			"Nothing was run. A snapshot that fails is a destruction that would not be recoverable."
}

# pin <rule-id> <top> <suffix> <sha> <what> — keep one commit reachable under refs/safety/.
pin() {
	local id="$1" top="$2" suffix="$3" sha="$4" what="$5"
	[ -n "$sha" ] || return 0
	store_ref "$top" "-$suffix" "$sha" || refuse "$id" "could not pin $what before dropping it."
	note "pinned $what → $STORED_REF"
}

# ── environment lookup (prefix > earlier `export` in the same command > the hook's env) ────────
EXPORTS=""
env_lookup() { # <NAME> — sets ENV_VAL and ENV_SRC (prefix|export|env|"")
	local name="$1" line
	ENV_VAL=""
	ENV_SRC=""
	while IFS= read -r line; do
		case "$line" in "$name="*)
			ENV_VAL="${line#*=}"
			ENV_SRC=prefix
			;;
		esac
	done <<<"$SEG_ENV"
	[ -n "$ENV_SRC" ] && { ENV_VAL="${ENV_VAL//\"/}"; ENV_VAL="${ENV_VAL//\'/}"; return 0; }
	while IFS= read -r line; do
		case "$line" in "$name="*)
			ENV_VAL="${line#*=}"
			ENV_SRC="export"
			;;
		esac
	done <<<"$EXPORTS"
	[ -n "$ENV_SRC" ] && { ENV_VAL="${ENV_VAL//\"/}"; ENV_VAL="${ENV_VAL//\'/}"; return 0; }
	if [ -n "${!name:-}" ]; then
		ENV_VAL="${!name}"
		ENV_SRC="env"
	fi
}

# ── R-DB ──────────────────────────────────────────────────────────────────────────────────────
# db_host <url> — sets DB_HOST; fails when the URL is not a parseable literal.
db_host() {
	local u="$1" q h hp
	DB_HOST=""
	case "$u" in *'$'* | *'`'* | "") return 1 ;; esac
	case "$u" in *://*) ;; *) return 1 ;; esac
	q=""
	case "$u" in *\?*) q="${u#*\?}" ;; esac
	u="${u#*://}"
	u="${u%%[/?]*}"
	hp="${u##*@}"
	case "$hp" in
	\[*)
		h="${hp#\[}"
		h="${h%%\]*}"
		;;
	*) h="${hp%%:*}" ;;
	esac
	# `?host=` overrides the authority part in libpq-style URLs
	case "&$q" in *"&host="*)
		h="${q#*host=}"
		h="${h%%&*}"
		case "$h" in /*) h="" ;; esac
		;;
	esac
	DB_HOST="$h"
	return 0
}

db_host_is_local() {
	case "$1" in
	"" | localhost | 127.* | ::1 | 0:0:0:0:0:0:0:1 | db | postgres | host.docker.internal) return 0 ;;
	esac
	return 1
}

rule_db() {
	# Only a program that can RUN the script: a commit message or a grep naming db:reset is text.
	case "${TOK[0]##*/}" in pnpm | npm | yarn | npx | pnpx | bun | bunx | node | tsx | drizzle-kit) ;; *) return 0 ;; esac
	case " $SEG " in
	*" db:reset"* | *" db:migrate"* | *" db:reencrypt"* | *"drizzle-kit push"* | *"drizzle-kit drop"* | *"drizzle-kit migrate"* | *"drizzle-kit up"* | *"scripts/reset.mjs"* | *"scripts/migrate.mjs"* | *"reencrypt-secrets"*) ;;
	*) return 0 ;;
	esac
	env_lookup ALETHIA_DATABASE_URL
	if [ "$ENV_SRC" != prefix ]; then
		case " $SEG " in *" --env-file"* | *" dotenv "*)
			refuse R-DB "\`$SEG\` loads its database URL from a file the guard cannot read." \
				"Prefix the command with an explicit local URL: ALETHIA_DATABASE_URL=postgres://…@localhost:5432/… <command>"
			;;
		esac
	fi
	if [ -z "$ENV_VAL" ]; then
		refuse R-DB "\`$SEG\` drops or rewrites a database, and no ALETHIA_DATABASE_URL is visible to the guard." \
			"Prefix the command with an explicit local URL (localhost, 127.0.0.1, ::1, or the compose host db/postgres) so the target is known before it runs."
	fi
	if ! db_host "$ENV_VAL"; then
		refuse R-DB "\`$SEG\` targets a database URL the guard cannot parse (a variable, a substitution, or not a URL)." \
			"Prefix the command with a literal local URL."
	fi
	db_host_is_local "$DB_HOST" ||
		refuse R-DB "\`$SEG\` would run against the database at host '$DB_HOST', which is not local." \
			"db:reset runs DROP SCHEMA public CASCADE; migrate/reencrypt rewrite live rows. A shared or production database is the maintainer's."
}

# ── R-PUSH ────────────────────────────────────────────────────────────────────────────────────
current_branch() { # <dir> — sets BRANCH ("" when detached or unknown)
	BRANCH=""
	[ -n "$1" ] || return 1
	BRANCH="$(git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null)"
}

# push_source_is_snapshot <src> — does pushing <src> publish snapshot content? True when <src>
# resolves (by any spelling: a short name git expands, a raw sha, a branch) to a ref under
# refs/safety/, or to a commit whose history — beyond what the remotes already have — holds a
# commit written by the snapshot identity. A branch made from a snapshot is caught here too;
# .githooks/pre-push repeats the history check on the exact range git is about to send.
push_source_is_snapshot() {
	local src="$1" full sha
	[ -n "$GDIR" ] && [ -n "$src" ] || return 1
	full="$(git -C "$GDIR" rev-parse --symbolic-full-name "$src" 2>/dev/null)"
	case "$full" in refs/safety/*) return 0 ;; esac
	sha="$(git -C "$GDIR" rev-parse -q --verify "$src^{commit}" 2>/dev/null)" || return 1
	git -C "$GDIR" log --format='%ae %ce' "$sha" --not --remotes 2>/dev/null | grep -qF "$SNAP_EMAIL"
}

# push_target_is_branch <name> <remote> — a local or remote-tracking branch exists and no tag does.
push_target_is_branch() {
	local name="$1" remote="${2:-origin}"
	[ -n "$GDIR" ] || return 1
	git -C "$GDIR" show-ref -q --verify "refs/tags/$name" 2>/dev/null && return 1
	git -C "$GDIR" show-ref -q --verify "refs/heads/$name" 2>/dev/null && return 0
	git -C "$GDIR" show-ref -q --verify "refs/remotes/$remote/$name" 2>/dev/null && return 0
	return 1
}

rule_push() {
	local i a remote="" force=0 del=0 all=0 prune=0 tags=0 n=${#GARGS[@]} specs=() skip=0 s src dst
	for ((i = 0; i < n; i++)); do
		a="${GARGS[$i]}"
		if [ "$skip" = 1 ]; then
			skip=0
			continue
		fi
		case "$a" in
		--mirror) refuse R-PUSH "\`git push --mirror\` overwrites and deletes every ref on the remote, dev/staging/main included." ;;
		-f | --force | --force-with-lease* | --force-if-includes) force=1 ;;
		-d | --delete) del=1 ;;
		--all | --branches) all=1 ;;
		--prune) prune=1 ;;
		--tags) tags=1 ;;
		--prune-tags)
			# @mut prune-tags
			refuse R-PUSH "\`--prune-tags\` deletes every remote tag that has no local copy."
			;;
		-o | --push-option | --repo | --receive-pack | --exec) skip=1 ;;
		--) ;;
		-*)
			case "$a" in -[a-zA-Z]*f*) [ "${a#--}" = "$a" ] && force=1 ;; esac
			case "$a" in -[a-zA-Z]*d*) [ "${a#--}" = "$a" ] && del=1 ;; esac
			;;
		*)
			if [ -z "$remote" ]; then remote="$a"; else specs+=("$a"); fi
			;;
		esac
	done
	if [ "$all" = 1 ] && [ "$force" = 1 ]; then
		refuse R-PUSH "\`git push --all --force\` force-pushes every local branch, dev/staging/main included."
	fi
	if [ "$prune" = 1 ]; then
		case " ${specs[*]} " in *refs/tags/*) tags=1 ;; esac
		if [ "$tags" = 1 ] || [ "$all" = 1 ]; then
			# @mut push-prune
			refuse R-PUSH "\`git push --prune\` with tags or --all deletes every remote ref that has no local copy — tags and protected branches included."
		fi
	fi
	if [ "$tags" = 1 ] && [ "$force" = 1 ]; then
		# @mut tags-force
		refuse R-PUSH "\`git push --tags --force\` moves published tags, which the release workflows build from."
	fi
	if [ ${#specs[@]} -eq 0 ]; then
		[ "$all" = 1 ] && return 0
		# No refspec: git pushes the current branch (or, under push.default=upstream, to its
		# upstream). Resolve that here rather than leave it to the pre-push hook.
		[ -n "$GDIR" ] || refuse R-PUSH "cannot tell which branch a bare \`git push\` pushes (the tree is an unexpanded variable)."
		current_branch "$GDIR"
		if push_source_is_snapshot HEAD; then
			# @mut push-snapshot-content
			refuse R-PUSH "\`git push\` would publish a snapshot commit: this branch's unpushed history holds a commit written by guard-destroy's snapshot identity, which can carry untracked private files." \
				"Restore files from a snapshot onto a normal commit instead (.claude/skills/dev/SKILL.md → Recovering from a destructive command)."
		fi
		if is_protected_branch "$BRANCH"; then
			refuse R-PUSH "a bare \`git push\` from a tree on \`$BRANCH\` pushes \`$BRANCH\`." \
				"Feature work goes to a feature branch and a PR into dev; promotions are PR merges (guard-merge.sh)."
		fi
		case "$(git -C "$GDIR" config --get push.default 2>/dev/null)" in upstream | tracking)
			dst="$(git -C "$GDIR" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)"
			dst="${dst#*/}"
			is_protected_branch "$dst" &&
				refuse R-PUSH "push.default=upstream sends this branch to \`$dst\`."
			;;
		esac
		return 0
	fi
	# A snapshot holds whatever untracked files the tree had — local documents, .bak files — and
	# this repository is PUBLIC. Snapshots never leave the machine.
	case " ${specs[*]} " in *refs/safety*)
		# @mut push-safety
		refuse R-PUSH "\`git push\` of refs/safety/* would publish local snapshots, which can hold untracked private files."
		;;
	esac
	for s in "${specs[@]}"; do
		s="${s#+}"
		src="${s%%:*}"
		if [ -n "$src" ] && push_source_is_snapshot "$src"; then
			# @mut push-snapshot-source
			refuse R-PUSH "\`git push\` of '$src' would publish a snapshot commit (a refs/safety ref under another name, or a history holding a commit written by the snapshot identity), which can carry untracked private files." \
				"Restore files from a snapshot onto a normal commit instead (.claude/skills/dev/SKILL.md → Recovering from a destructive command)."
		fi
		case "$s" in
		*:*)
			src="${s%%:*}"
			dst="${s##*:}"
			;;
		*)
			src="$s"
			dst="$s"
			;;
		esac
		if [ "$dst" = HEAD ] || [ "$dst" = "@" ]; then
			current_branch "$GDIR"
			dst="$BRANCH"
		fi
		case "$dst" in
		refs/tags/*)
			if [ "$del" = 1 ] || [ -z "$src" ]; then
				refuse R-PUSH "\`git push\` would delete the remote tag ${dst#refs/tags/}." \
					"Release tags drive the release workflows; a deleted tag is a deleted release input."
			fi
			continue
			;;
		esac
		# A delete by SHORT name: git resolves it against the remote's refs, and a tag is as
		# likely as a branch. It is a branch only when this repository knows a branch of that
		# name (local, or remote-tracking for that remote) and no tag of that name.
		if { [ "$del" = 1 ] || [ -z "$src" ]; } && ! is_protected_branch "${dst#refs/heads/}"; then
			case "$dst" in
			refs/heads/*) ;;
			*)
				if ! push_target_is_branch "$dst" "$remote"; then
					# @mut tag-short
					refuse R-PUSH "\`git push\` would delete '$dst' on the remote, and it is not a branch this repository knows — it may be a tag." \
						"Release tags drive the release workflows. To delete a remote BRANCH, spell it refs/heads/$dst."
				fi
				;;
			esac
		fi
		dst="${dst#refs/heads/}"
		dst="${dst#heads/}"
		case "$dst" in *\**)
			refuse R-PUSH "a wildcard refspec ($s) would push to dev/staging/main as well." ;;
		esac
		if is_protected_branch "$dst"; then
			if [ "$del" = 1 ] || [ -z "$src" ]; then
				refuse R-PUSH "\`git push\` would DELETE the remote \`$dst\` branch."
			fi
			refuse R-PUSH "\`git push\` would write the protected branch \`$dst\` directly." \
				"dev, staging and main change only through merged PRs: feature → dev by the queue, promotions through guard-merge.sh."
		fi
	done
}

# ── git: snapshots, pins and the tfstate case of git clean ─────────────────────────────────────
# git_parse — split TOK into GDIR (the tree it acts on, "" when unknown), GSUB and GARGS.
git_parse() {
	local i=1 n=${#TOK[@]} d
	GDIR="$DIR"
	while [ "$i" -lt "$n" ]; do
		case "${TOK[$i]}" in
		-C)
			xp "${TOK[$((i + 1))]:-}"
			d="$X"
			if [ -z "$GDIR" ] || cmdline_has_var "$d"; then GDIR=""; else
				cmdline_abspath "$d" "$GDIR"
				GDIR="$ABSPATH"
			fi
			i=$((i + 2))
			;;
		--work-tree=*)
			xp "${TOK[$i]#--work-tree=}"
			d="$X"
			if cmdline_has_var "$d"; then GDIR=""; else
				cmdline_abspath "$d" "${GDIR:-/}"
				GDIR="$ABSPATH"
			fi
			i=$((i + 1))
			;;
		-c | --git-dir | --namespace | --work-tree) i=$((i + 2)) ;;
		-*) i=$((i + 1)) ;;
		*) break ;;
		esac
	done
	GSUB="${TOK[$i]:-}"
	GARGS=("${TOK[@]:$((i + 1))}")
}

has_arg() { # <pattern>… — does any of GARGS match one of the (case) patterns?
	local a p
	for a in "${GARGS[@]}"; do
		for p in "$@"; do
			# shellcheck disable=SC2254
			case "$a" in $p) return 0 ;; esac
		done
	done
	return 1
}

rule_git() {
	git_parse
	local label="git $GSUB ${GARGS[*]}"
	label="${label% }"
	case "$GSUB" in
	push) rule_push ;;
	reset)
		has_arg --hard && snap S-TREE "$GDIR" "$label"
		;;
	clean)
		has_arg -n --dry-run '-[a-zA-Z]*n*' && return 0
		if has_arg '-[a-zA-Z]*[xX]*'; then
			if [ -z "$GDIR" ]; then
				refuse R-TFSTATE "cannot tell which tree \`$label\` cleans, and -x/-X deletes ignored files such as terraform.tfstate."
			fi
			if find_top "$GDIR" && tree_has_tfstate "$TOP"; then
				case "$SEG" in *-e*tfstate*) ;; *)
					refuse R-TFSTATE "\`$label\` deletes IGNORED files, and $TOP holds local terraform state (terraform.tfstate*) with no other copy." \
						"Keep the state with an exclude:  $label -e '*.tfstate*'"
					;;
				esac
			fi
		fi
		snap S-TREE "$GDIR" "$label"
		;;
	checkout)
		has_arg -b -B --orphan && return 0
		snap S-TREE "$GDIR" "$label"
		;;
	switch)
		has_arg -f --force --discard-changes && snap S-TREE "$GDIR" "$label"
		;;
	restore)
		snap S-TREE "$GDIR" "$label"
		;;
	rm)
		has_arg -f --force '-[a-zA-Z]*f*' && snap S-TREE "$GDIR" "$label"
		;;
	stash)
		rule_stash
		;;
	worktree)
		[ "${GARGS[0]:-}" = remove ] || return 0
		local a target=""
		for a in "${GARGS[@]:1}"; do
			case "$a" in -*) ;; *)
				target="$a"
				break
				;;
			esac
		done
		[ -n "$target" ] || return 0
		xp "$target"
		target="$X"
		if cmdline_has_var "$target" || [ -z "$GDIR" ]; then
			refuse R-TFSTATE "cannot tell which tree \`$label\` removes, so neither its local state nor its work can be checked first." \
				"Spell the path literally."
		fi
		cmdline_abspath "$target" "$GDIR"
		# Forced or not: plain `worktree remove` also deletes IGNORED files, and a snapshot can
		# never see them. Local tfstate has no other copy, so the same refusal as `rm -r`.
		if [ -d "$ABSPATH" ] && tree_has_tfstate "$ABSPATH"; then
			# @mut wt-tfstate
			refuse R-TFSTATE "\`$label\` removes a worktree holding local terraform state (terraform.tfstate*), which no snapshot can capture." \
				"Move the state out first, or have the maintainer remove the tree."
		fi
		has_arg -f --force || return 0
		snap S-WTREE "$ABSPATH" "$label"
		;;
	branch)
		rule_branch_delete
		;;
	esac
}

rule_stash() {
	local verb="${GARGS[0]:-}" which a sha i=0 line
	case "$verb" in drop | clear) ;; *) return 0 ;; esac
	[ -n "$GDIR" ] || snap S-STASH "" "git stash $verb"
	find_top "$GDIR" || return 0
	safety_ts
	if [ "$verb" = clear ]; then
		while IFS= read -r line; do
			[ -n "$line" ] || continue
			pin S-STASH "$TOP" "stash-$i" "$line" "stash@{$i}"
			i=$((i + 1))
		done <<EOF
$(git -C "$TOP" stash list --format=%H 2>/dev/null)
EOF
		return 0
	fi
	which="stash@{0}"
	for a in "${GARGS[@]:1}"; do
		case "$a" in
		-*) ;;
		[0-9]*) which="stash@{$a}" ;;
		*) which="$a" ;;
		esac
	done
	sha="$(git -C "$TOP" rev-parse -q --verify "$which" 2>/dev/null)"
	local idx="${which#*\{}"
	idx="${idx%\}}"
	pin S-STASH "$TOP" "stash-$idx" "$sha" "$which"
}

rule_branch_delete() {
	local a force=0 del=0 names=()
	for a in "${GARGS[@]}"; do
		case "$a" in
		-D) force=1 del=1 ;;
		-d | --delete) del=1 ;;
		-f | --force) force=1 ;;
		-*) ;;
		*) names+=("$a") ;;
		esac
	done
	[ "$del" = 1 ] && [ "$force" = 1 ] || return 0
	[ ${#names[@]} -gt 0 ] || return 0
	[ -n "$GDIR" ] || snap S-BRANCH "" "git branch -D"
	find_top "$GDIR" || return 0
	safety_ts
	local nm sha
	for nm in "${names[@]}"; do
		sha="$(git -C "$TOP" rev-parse -q --verify "refs/heads/$nm" 2>/dev/null)"
		pin S-BRANCH "$TOP" "branch-${nm//\//_}" "$sha" "branch $nm"
	done
}

# ── rm and friends: credentials, the git dir, tfstate, then the snapshot ───────────────────────
rule_rm() {
	local prog="$1" a recursive=0 targets=() endopts=0 unresolved=0 t P c
	shift
	for a in "${TOK[@]:1}"; do
		if [ "$endopts" = 0 ]; then
			case "$a" in
			--) endopts=1 && continue ;;
			--recursive) recursive=1 && continue ;;
			-*)
				case "$a" in -*[rR]*) [ "${a#--}" = "$a" ] && recursive=1 ;; esac
				continue
				;;
			esac
		fi
		targets+=("$a")
	done
	[ "$prog" = shred ] || [ "$prog" = truncate ] || [ "$prog" = unlink ] && recursive=0
	cred_paths
	common_git_dir
	local tops=() specs=()
	for t in "${targets[@]}"; do
		xp "$t"
		t="$X"
		case "$t" in *'$'* | *'`'*)
			case "$t" in "\$HOME"* | "\${HOME}"*) ;; *)
				unresolved=1
				continue
				;;
			esac
			;;
		esac
		[ -n "$DIR" ] || case "$t" in /* | "~"*) ;; *)
			unresolved=1
			continue
			;;
		esac
		cmdline_abspath "$t" "${DIR:-/}"
		P="$ABSPATH"
		for c in "${CREDS[@]}"; do
			path_overlaps "$P" "$c" && refuse R-CRED "\`$prog $t\` removes $c, a credential directory." \
				"Credentials are not recreatable by an agent. Move nothing out of these directories without the maintainer."
		done
		# The git dir itself or an ancestor of it — NOT a file inside it (`rm .git/index.lock`
		# is the ordinary fix for a crashed git and must stay allowed).
		if [ -n "$COMMON_GIT" ]; then
			if [ "$P" = "$COMMON_GIT" ] || [ "$P" = / ] || case "$COMMON_GIT" in "$P"/*) true ;; *) false ;; esac; then
				refuse R-GITDIR "\`$prog $t\` removes $COMMON_GIT — the repository itself, and every safety snapshot in it."
			fi
		fi
		case "$P" in */.git) [ -d "$P" ] && refuse R-GITDIR "\`$prog $t\` removes a repository's .git directory." ;; esac
		is_tfstate_path "$P" && refuse R-TFSTATE "\`$prog $t\` removes local terraform state, which has no other copy." \
			"infra/*-e2e and infra/sandbox keep their state on this machine; losing it orphans real cloud resources."
		if [ "$recursive" = 1 ] && [ -d "$P" ] && tree_has_tfstate "$P"; then
			refuse R-TFSTATE "\`$prog -r $t\` removes a directory holding local terraform state (terraform.tfstate*)."
		fi
		case "$P" in *[\*\?\[]*) P="${P%%[\*\?\[]*}" && P="${P%/*}" ;; esac
		[ -e "$P" ] || continue
		if find_top "$P"; then
			local rel="${P#"$TOP"}"
			rel="${rel#/}"
			[ -n "$rel" ] || rel=":/"
			tops+=("$TOP")
			specs+=("$rel")
		fi
	done
	# Group pathspecs by tree; one snapshot per tree.
	local i j top sp
	for ((i = 0; i < ${#tops[@]}; i++)); do
		top="${tops[$i]}"
		[ -n "$top" ] || continue
		sp=()
		for ((j = i; j < ${#tops[@]}; j++)); do
			if [ "${tops[$j]}" = "$top" ]; then
				sp+=("${specs[$j]}")
				tops[$j]=""
			fi
		done
		snapshot S-RM "$top" "$prog ${targets[*]}" "${sp[@]}"
	done
	if [ "$unresolved" = 1 ] && [ -n "$DIR" ] && find_top "$DIR"; then
		# Best effort for `rm -rf "$x"`: save the tree we are standing in.
		snapshot S-RM "$TOP" "$prog ${targets[*]}"
	fi
	return 0
}

rule_mv_cp() { # mv anything tfstate/credential; cp ONTO a tfstate
	local prog="$1" a last="" args=() P c
	for a in "${TOK[@]:1}"; do
		case "$a" in -*) ;; *) args+=("$a") ;; esac
	done
	[ ${#args[@]} -gt 0 ] || return 0
	last="${args[${#args[@]} - 1]}"
	cred_paths
	for a in "${args[@]}"; do
		xp "$a"
		a="$X"
		cmdline_has_var "$a" && continue
		cmdline_abspath "$a" "${DIR:-/}"
		P="$ABSPATH"
		if [ "$prog" = mv ]; then
			is_tfstate_path "$P" && refuse R-TFSTATE "\`mv $a\` moves or overwrites local terraform state."
			for c in "${CREDS[@]}"; do
				path_overlaps "$P" "$c" && [ "$a" != "$last" ] && refuse R-CRED "\`mv $a\` moves a credential directory out of place."
			done
		fi
	done
	cmdline_abspath "$last" "${DIR:-/}"
	is_tfstate_path "$ABSPATH" && [ ${#args[@]} -ge 2 ] && refuse R-TFSTATE "\`$prog … $last\` overwrites local terraform state."
	return 0
}

# Output redirection onto tfstate or a credential file, judged on the RAW segment because
# `echo x > terraform.tfstate` is a perfectly ordinary echo otherwise.
rule_redirect() {
	local s="$1" t
	cred_paths
	while [[ "$s" =~ \>+[[:space:]]*([^[:space:]\>]+) ]]; do
		t="${BASH_REMATCH[1]}"
		s="${s#*"${BASH_REMATCH[0]}"}"
		t="${t//\"/}"
		t="${t//\'/}"
		case "$t" in /dev/* | "&"*) continue ;; esac
		cmdline_has_var "$t" && continue
		cmdline_abspath "$t" "${DIR:-/}"
		is_tfstate_path "$ABSPATH" && refuse R-TFSTATE "a redirection overwrites $t, local terraform state."
		local c
		for c in "${CREDS[@]}"; do
			case "$ABSPATH" in "$c"/*) refuse R-CRED "a redirection overwrites $t, inside $c." ;; esac
		done
	done
	return 0
}

# find … -delete / -exec rm, and rsync --delete: the two bulk deleters with no rm in front of them.
rule_find_rsync() {
	local prog="$1" a roots=() last=""
	if [ "$prog" = find ]; then
		case " $SEG " in *" -delete"* | *" -exec rm "* | *" -execdir rm "* | *"/rm "*) ;; *) return 0 ;; esac
		case "$SEG" in *tfstate*)
			# @mut find-tfstate
			refuse R-TFSTATE "\`find … -delete\` names terraform state."
			;;
		esac
		# with no name or path filter, everything under the roots goes
		case " $SEG " in *" -name "* | *" -iname "* | *" -path "* | *" -ipath "* | *" -regex "* | *" -iregex "*) return 0 ;; esac
		for a in "${TOK[@]:1}"; do
			case "$a" in -* | "(" | "!") break ;; esac
			roots+=("$a")
		done
		[ ${#roots[@]} -gt 0 ] || roots=(.)
		for a in "${roots[@]}"; do
			cmdline_has_var "$a" && continue
			cmdline_abspath "$a" "${DIR:-/}"
			[ -d "$ABSPATH" ] && tree_has_tfstate "$ABSPATH" &&
				refuse R-TFSTATE "\`find $a … -delete\` deletes everything under a directory holding local terraform state."
		done
		return 0
	fi
	# rsync
	case " $SEG " in *" --delete"* | *" --del "*) ;; *) return 0 ;; esac
	for a in "${TOK[@]:1}"; do
		case "$a" in -*) ;; *) last="$a" ;; esac
	done
	[ -n "$last" ] || return 0
	case "$last" in *:*) return 0 ;; esac
	cmdline_abspath "$last" "${DIR:-/}"
	if is_tfstate_path "$ABSPATH" || { [ -d "$ABSPATH" ] && tree_has_tfstate "$ABSPATH"; }; then
		# @mut rsync-tfstate
		refuse R-TFSTATE "\`rsync --delete … $last\` can delete local terraform state in the destination."
	fi
	return 0
}

rule_tofu() {
	local a nf=() i
	for a in "${TOK[@]:1}"; do
		case "$a" in -*) ;; *) nf+=("$a") ;; esac
	done
	case "${nf[0]:-}" in
	state)
		case "${nf[1]:-}" in rm | mv | push | replace-provider)
			refuse R-TFSTATE "\`${TOK[0]} state ${nf[1]}\` rewrites terraform state in place." \
				"State surgery can orphan or double-own real cloud resources; it is a reviewed, human operation."
			;;
		esac
		;;
	init)
		case " ${TOK[*]} " in *" -migrate-state"* | *" -force-copy"*)
			refuse R-TFSTATE "\`${TOK[0]} init -migrate-state/-force-copy\` moves state between backends and can overwrite the destination." ;;
		esac
		;;
	workspace)
		[ "${nf[1]:-}" = delete ] && refuse R-TFSTATE "\`${TOK[0]} workspace delete\` deletes a workspace's state."
		;;
	esac
	return 0
}

rule_docker() {
	local sub="${TOK[1]:-}" verb="${TOK[2]:-}" a
	case "$sub" in
	volume)
		case "$verb" in
		prune) refuse R-DOCKER "\`docker volume prune\` deletes every unused volume — the alethia database volumes included whenever the stack is stopped." ;;
		rm | remove)
			for a in "${TOK[@]:3}"; do
				case "$a" in *alethia* | *'$'* | *'`'*)
					refuse R-DOCKER "\`docker volume $verb $a\` deletes an alethia data volume (or one the guard cannot name)." \
						"Reset only YOUR environment's database: pnpm env:up --fresh"
					;;
				esac
			done
			;;
		esac
		;;
	system)
		[ "$verb" = prune ] && case " ${TOK[*]} " in *" --volumes"*)
			refuse R-DOCKER "\`docker system prune --volumes\` deletes every unused volume." ;;
		esac
		;;
	rm | container)
		[ "$sub" = container ] && [ "$verb" != rm ] && return 0
		case " ${TOK[*]} " in *" -v"* | *" --volumes"* | *" -fv"*)
			for a in "${TOK[@]:2}"; do
				case "$a" in *alethia*) refuse R-DOCKER "\`docker rm -v $a\` removes an alethia container together with its volumes." ;; esac
			done
			;;
		esac
		;;
	esac
	return 0
}

# ── R-CLOUD ───────────────────────────────────────────────────────────────────────────────────
nonflag_words() { # sets NF: the words after TOK[0] that are not flags or a known flag's value
	local i n=${#TOK[@]} a skip=0
	NF=()
	for ((i = 1; i < n; i++)); do
		a="${TOK[$i]}"
		if [ "$skip" = 1 ]; then
			skip=0
			continue
		fi
		case "$a" in
		--profile | --region | --output | --endpoint-url | --query | --color | --ca-bundle | --context | --project | --zone | --subscription | -g | --resource-group | --kubeconfig | --kube-context | -n | --namespace | --format) skip=1 ;;
		-*) ;;
		*) NF+=("$a") ;;
		esac
	done
}

hcloud_context() { # sets HCTX ("" when none), HTOKEN=1 when a token prefix bypasses contexts
	local i n=${#TOK[@]}
	HCTX=""
	HTOKEN=0
	for ((i = 1; i < n; i++)); do
		case "${TOK[$i]}" in
		--context) HCTX="${TOK[$((i + 1))]:-}" ;;
		--context=*) HCTX="${TOK[$i]#--context=}" ;;
		esac
	done
	if [ -z "$HCTX" ]; then
		env_lookup HCLOUD_CONTEXT
		HCTX="$ENV_VAL"
	fi
	# A token overrides whatever project the context names, so ANY token makes the project unknown.
	env_lookup HCLOUD_TOKEN
	[ -n "$ENV_VAL" ] && HTOKEN=1
	return 0
}

hcloud_disposable() {
	case "$1" in alethia-e2e | alethia-sandbox) return 0 ;; esac
	return 1
}

kube_context() { # sets KCTX from the flags, else asks kubectl (only on the delete path)
	local i n=${#TOK[@]} kc=""
	KCTX=""
	for ((i = 1; i < n; i++)); do
		case "${TOK[$i]}" in
		--context | --kube-context) KCTX="${TOK[$((i + 1))]:-}" ;;
		--context=* | --kube-context=*) KCTX="${TOK[$i]#*=}" ;;
		--kubeconfig) kc="${TOK[$((i + 1))]:-}" ;;
		--kubeconfig=*) kc="${TOK[$i]#*=}" ;;
		esac
	done
	if [ -z "$KCTX" ] && command -v kubectl >/dev/null 2>&1; then
		if [ -n "$kc" ]; then
			KCTX="$(kubectl --kubeconfig "$kc" config current-context 2>/dev/null)"
		else
			KCTX="$(kubectl config current-context 2>/dev/null)"
		fi
	fi
}

kube_disposable() {
	case "$1" in kind-* | *-e2e*) return 0 ;; esac
	return 1
}

rule_cloud() {
	local prog="$1"
	nonflag_words
	case "$prog" in
	hcloud)
		case "${NF[1]:-}" in delete | rebuild | delete-*) ;; *) return 0 ;; esac
		hcloud_context
		[ "$HTOKEN" = 1 ] && refuse R-CLOUD "\`hcloud ${NF[0]} ${NF[1]}\` with an HCLOUD_TOKEN prefix — the guard cannot tell which project it deletes in."
		hcloud_disposable "$HCTX" ||
			refuse R-CLOUD "\`hcloud ${NF[0]} ${NF[1]}\` outside a disposable project (context '${HCTX:-<the global default>}')." \
				"The default hcloud context on this Mac is ANOTHER company's production. Only --context alethia-e2e or alethia-sandbox is disposable."
		;;
	aws)
		local svc="${NF[0]:-}" op="${NF[1]:-}"
		if [ "$svc" = s3 ]; then
			case "$op" in rm | rb | mv) refuse R-CLOUD "\`aws s3 $op\` deletes objects or a bucket." ;; esac
			[ "$op" = sync ] && case " ${TOK[*]} " in *" --delete"*) refuse R-CLOUD "\`aws s3 sync --delete\` deletes objects." ;; esac
			return 0
		fi
		case "$op" in delete-* | terminate-* | remove-* | deregister-* | purge-* | batch-delete-* | schedule-key-deletion | disable-key)
			refuse R-CLOUD "\`aws $svc $op\` deletes a cloud resource; there is no disposable AWS target on this machine." ;;
		esac
		;;
	gcloud | az)
		local w
		for w in "${NF[@]}"; do
			case "$w" in delete | purge | remove)
				refuse R-CLOUD "\`$prog … $w\` deletes a cloud resource; there is no disposable $prog target on this machine." ;;
			esac
		done
		;;
	aliyun)
		case "${NF[1]:-}" in Delete* | Release* | Remove* | Terminate* | Unbind* | Detach*)
			refuse R-CLOUD "\`aliyun ${NF[0]} ${NF[1]}\` deletes a cloud resource." ;;
		esac
		;;
	kubectl)
		local sub="${NF[0]:-}"
		case "$sub" in
		delete | drain) ;;
		replace) case " ${TOK[*]} " in *" --force"*) ;; *) return 0 ;; esac ;;
		apply) case " ${TOK[*]} " in *" --prune"*) ;; *) return 0 ;; esac ;;
		*) return 0 ;;
		esac
		kube_context
		kube_disposable "$KCTX" ||
			refuse R-CLOUD "\`kubectl $sub\` in context '${KCTX:-<unknown>}', which is not a kind-* or *-e2e* cluster."
		;;
	helm)
		case "${NF[0]:-}" in uninstall | delete | del | un) ;; *) return 0 ;; esac
		kube_context
		kube_disposable "$KCTX" ||
			refuse R-CLOUD "\`helm ${NF[0]}\` in context '${KCTX:-<unknown>}', which is not a kind-* or *-e2e* cluster."
		;;
	esac
	return 0
}

# ── R-GH / R-GHAPI ────────────────────────────────────────────────────────────────────────────
GH_API_PROTECTED_RE='(^|/)(rulesets|protection|releases|packages|environments|hooks|actions/secrets|dependabot/secrets|codespaces/secrets|tags/protection)(/|$)'
# git/refs is protected only for dev/staging/main and for tags: PATCHing a feature branch's ref
# (rebasing a dependabot branch through the API) is the same as force-pushing a feature branch,
# which R-PUSH allows. A ref path the guard cannot read (a variable) is refused.
GH_API_REFS_RE='(^|/)git/refs(/heads/(dev|staging|main)/?$|/tags(/|$)|/?$)'
GH_API_REFS_ANY_RE='(^|/)git/refs/'

GH_API_ROOT_RE='^(repos/[^/]+/[^/]+|orgs/[^/]+)/?$'
GH_API_POST_RE='(/transfer|/branches/[^/]+/rename)$'
GH_GRAPHQL_RE='(deleteRef|updateRefs?|deleteBranchProtectionRule|updateBranchProtectionRule|deleteRepositoryRuleset|updateRepositoryRuleset|archiveRepository|updateRepository|transferRepository|deleteEnvironment|deleteRelease|deletePackageVersion|deleteIssue|deleteDiscussion)[[:space:]]*(\(|$)'

rule_gh() {
	local sub="${TOK[1]:-}" verb="${TOK[2]:-}"
	case "$sub" in
	repo)
		case "$verb" in
		delete | archive | rename) refuse R-GH "\`gh repo $verb\` — the repository is not an agent's to $verb." ;;
		edit) case " ${TOK[*]} " in *" --visibility"*) refuse R-GH "\`gh repo edit --visibility\` changes who can see the repository." ;; esac ;;
		esac
		;;
	release) case "$verb" in delete | delete-asset) refuse R-GH "\`gh release $verb\` deletes a published release or its assets." ;; esac ;;
	secret) case "$verb" in delete | remove) refuse R-GH "\`gh secret $verb\` deletes a secret; its value cannot be recovered." ;; esac ;;
	issue) [ "$verb" = delete ] && refuse R-GH "\`gh issue delete\` deletes an issue and its history (close it instead)." ;;
	api) rule_gh_api ;;
	esac
	return 0
}

rule_gh_api() {
	local i n=${#TOK[@]} a method="" path="" body=0 input=0
	for ((i = 2; i < n; i++)); do
		a="${TOK[$i]}"
		case "$a" in
		-X | --method)
			method="${TOK[$((i + 1))]:-}"
			i=$((i + 1))
			;;
		-X*) method="${a#-X}" ;;
		--method=*) method="${a#--method=}" ;;
		-F | --field)
			body=1
			# `-F query=@file` reads the body from a file, exactly like --input
			case "${TOK[$((i + 1))]:-}" in *=@*) input=1 ;; esac
			i=$((i + 1))
			;;
		-f | --raw-field)
			body=1
			i=$((i + 1))
			;;
		--input)
			input=1
			body=1
			i=$((i + 1))
			;;
		-H | --header | -q | --jq | -t | --template | -p | --preview | --hostname | --cache) i=$((i + 1)) ;;
		-*) ;;
		*) [ -n "$path" ] || path="$a" ;;
		esac
	done
	# a full URL (`https://api.github.com/repos/…`, or a GHES `…/api/v3/…`) is the same path
	case "$path" in
	http://* | https://*)
		path="${path#*://}"
		path="${path#*/}"
		path="${path#api/v3/}"
		;;
	esac
	path="${path#/}"
	path="${path%%\?*}"
	if [ -z "$method" ]; then
		[ "$body" = 1 ] && method=POST || method=GET
	fi
	method="$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')"
	if [ "$path" = graphql ]; then
		if [ "$input" = 1 ]; then
			# @mut graphql-file
			refuse R-GHAPI "\`gh api graphql\` reads its query from a file or stdin, which the guard cannot read." \
				"Pass the query inline with -f query='…' so the mutation is visible."
		fi
		[[ "$CMD" =~ $GH_GRAPHQL_RE ]] && refuse R-GHAPI "a graphql \`${BASH_REMATCH[1]}\` mutation deletes or rewrites repository state."
		return 0
	fi
	xp "$path"
	path="$X"
	case "$method" in
	DELETE | PUT | PATCH)
		if [[ "$path" =~ $GH_API_REFS_ANY_RE ]]; then
			local ref="${path#*git/refs/}"
			if [[ "$path" =~ $GH_API_REFS_RE ]] || cmdline_has_var "$ref"; then
				refuse R-GHAPI "\`gh api -X $method $path\` rewrites or deletes a protected ref (dev/staging/main or a tag)."
			fi
			return 0
		fi
		if [[ "$path" =~ $GH_API_PROTECTED_RE ]] || [[ "$path" =~ $GH_API_ROOT_RE ]]; then
			refuse R-GHAPI "\`gh api -X $method $path\` writes protected repository state (rules, protection, releases, refs, packages, environments, hooks, secrets, or the repo itself)."
		fi
		;;
	POST)
		[[ "$path" =~ $GH_API_POST_RE ]] && refuse R-GHAPI "\`gh api -X POST $path\` transfers the repository or renames a branch."
		;;
	GET | HEAD) ;;
	*)
		# A method the guard cannot read (a variable) on a protected path fails closed.
		if [[ "$path" =~ $GH_API_PROTECTED_RE ]] || [[ "$path" =~ $GH_API_ROOT_RE ]]; then
			refuse R-GHAPI "\`gh api\` with an unreadable method ($method) on the protected path $path."
		fi
		;;
	esac
	return 0
}

# ── main ──────────────────────────────────────────────────────────────────────────────────────
main() {
	cmdline_read_payload
	[ -n "$CMD" ] || exit 0
	# A cheap first look, with no fork: a command naming none of these cannot match any rule.
	case "$CMD" in
	*git* | *gh* | *rm* | *tofu* | *tfstate* | *db:* | *drizzle* | *.mjs* | *reencrypt* | *docker* | *hcloud* | *aws* | *gcloud* | *az* | *aliyun* | *kubectl* | *helm* | *mv* | *cp* | *shred* | *unlink* | *truncate* | *find* | *rsync* | *\>*) ;;
	*) exit 0 ;;
	esac
	cmdline_split "$CMD"
	DIR="$CWD"
	local raw prog a
	for raw in "${SEGS[@]}"; do
		case "$raw" in *\>*) rule_redirect "$raw" ;; esac
		cmdline_normalise "$raw"
		if [ ${#TOK[@]} -eq 0 ]; then
			[ -n "$SEG_ENV" ] && EXPORTS="$EXPORTS$SEG_ENV"
			continue
		fi
		prog="${TOK[0]##*/}"
		case "$prog" in
		cd | pushd)
			xp "${TOK[1]:-}"
			a="$X"
			case "$a" in
			"") DIR="$HOME" ;;
			- | *'$'* | *'`'*)
				case "$a" in
				"\$HOME"* | "\${HOME}"*)
					cmdline_abspath "$a" /
					DIR="$ABSPATH"
					;;
				*) DIR="" ;;
				esac
				;;
			/* | "~"*)
				cmdline_abspath "$a" /
				DIR="$ABSPATH"
				;;
			*)
				if [ -n "$DIR" ]; then
					cmdline_abspath "$a" "$DIR"
					DIR="$ABSPATH"
				fi
				;;
			esac
			continue
			;;
		export)
			for a in "${TOK[@]:1}"; do
				case "$a" in *=*) EXPORTS="$EXPORTS$a"$'\n' ;; esac
			done
			continue
			;;
		esac
		cmdline_is_inspect && continue
		case "$prog" in
		git) rule_git ;;
		gh) rule_gh ;;
		rm | unlink | shred | truncate) rule_rm "$prog" ;;
		mv | cp) rule_mv_cp "$prog" ;;
		tofu | terraform) rule_tofu ;;
		find | rsync) rule_find_rsync "$prog" ;;
		docker) rule_docker ;;
		hcloud | aws | gcloud | az | aliyun | kubectl | helm) rule_cloud "$prog" ;;
		esac
		rule_db
	done
	exit 0
}

# ── self-test ─────────────────────────────────────────────────────────────────────────────────
# `bash .claude/hooks/guard-destroy.sh --self-test`. Builds a real repository with a linked
# worktree in a tmpdir, a fake $HOME, and stubs for kubectl, so it is hermetic. Counters are
# incremented in THIS shell (never a pipeline or `$( )`), and the exit code is the test.
#
# `--mutation-test` copies the hook, disables each rule's call sites in turn (`refuse R-X` /
# `snap S-X` / `pin S-X` → `true`), and requires the self-test to FAIL for every one. The rule
# list is DERIVED from the file, so a new rule without a failing case fails the mutation test.
self_test() {
	local self="$1" tmp repo wt home stub pass=0 fail=0
	tmp="$(mktemp -d)"
	tmp="$(cd "$tmp" && pwd -P)"
	trap 'rm -rf "$tmp"' EXIT
	repo="$tmp/repo"
	wt="$tmp/wt-a"
	home="$tmp/home"
	stub="$tmp/stub"
	mkdir -p "$repo" "$home/.ssh" "$home/.aws" "$home/.config/gcloud" "$home/.cloudflared" "$home/scratch" "$stub"
	G() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=dev "$@" >/dev/null 2>&1; }
	G -C "$repo" init
	printf 'one\n' >"$repo/file.txt"
	printf '*.tfstate*\nnode_modules/\n' >"$repo/.gitignore"
	G -C "$repo" add -A
	G -C "$repo" commit -m init
	G -C "$repo" worktree add -b feat/a "$wt"
	G -C "$repo" branch doomed
	cat >"$stub/kubectl" <<'STUB'
#!/usr/bin/env bash
[ "$1 $2" = "config current-context" ] && { echo "${STUB_KUBE_CONTEXT:-prod-cluster}"; exit 0; }
exit 1
STUB
	chmod +x "$stub/kubectl"

	run() { # <cwd> <command> [env…] — sets RC
		local cwd="$1" cmd="$2" payload
		shift 2
		payload="$(jq -n --arg c "$cmd" --arg d "$cwd" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')"
		printf '%s' "$payload" | env HOME="$home" CLAUDE_PROJECT_DIR="$repo" PATH="$stub:$PATH" \
			ALETHIA_DATABASE_URL= HCLOUD_CONTEXT= HCLOUD_TOKEN= "$@" bash "$self" >/dev/null 2>"$tmp/stderr"
		RC=$?
	}
	t() { # <block|allow> <cwd> <command> [env…]
		local want="$1" cwd="$2" cmd="$3" got
		shift 3
		run "$cwd" "$cmd" "$@"
		# 0 = allow, 2 = block, anything else is the hook CRASHING — never an allow.
		case "$RC" in 0) got=allow ;; 2) got=block ;; *) got="crash(rc=$RC: $(head -c 200 "$tmp/stderr"))" ;; esac
		if [ "$got" = "$want" ]; then pass=$((pass + 1)); else
			fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
			echo "  ✗ want=$want got=$got : $cmd"
		fi
	}
	# snapped <want-new-refs> <label> <cwd> <command> — the command is ALLOWED and leaves exactly
	# N new refs under refs/safety/. NEW is the first of them (by name), for the content checks.
	snapped() {
		local want="$1" label="$2" got
		git -C "$repo" for-each-ref --format='%(refname)' refs/safety/ | sort >"$tmp/before"
		run "$3" "$4"
		git -C "$repo" for-each-ref --format='%(refname)' refs/safety/ | sort >"$tmp/after"
		comm -13 "$tmp/before" "$tmp/after" >"$tmp/new"
		got="$(wc -l <"$tmp/new" | tr -d ' ')"
		NEW="$(head -1 "$tmp/new")"
		if [ "$RC" = 0 ] && [ "$got" = "$want" ]; then pass=$((pass + 1)); else
			fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
			echo "  ✗ $label: rc=$RC new refs=$got want $want : $4"
		fi
	}
	bad_case() {
		fail=$((fail + 1))
		echo "  ✗ $1"
		[ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
	}
	# The repository whose .githooks/pre-push is under test: this file's own checkout, or the
	# mutation harness's copy.
	REPO_ROOT="${HOOK_ROOT:-$(cd "${self%/*}/../.." && pwd)}"
	check() { # <label> <condition-command…>
		local label="$1"
		shift
		if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); else
			fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
			echo "  ✗ $label"
		fi
	}

	# ── R-PUSH ──
	t block "$wt" 'git push origin main'
	t block "$wt" 'git push origin staging'
	t block "$wt" 'git push -f origin main'
	t block "$wt" 'git push origin +main'
	t block "$wt" 'git push origin HEAD:main'
	t block "$wt" 'git push origin feat/a:refs/heads/dev'
	t block "$wt" 'git push origin :main'
	t block "$wt" 'git push --delete origin staging'
	t block "$wt" 'git push --mirror origin'
	t block "$wt" 'git push --all --force origin'
	t block "$wt" 'git push origin :refs/tags/v1.2.3'
	t block "$wt" "git -C $repo push"
	t block "$repo" 'git push'
	t block "$wt" 'git push origin "refs/heads/*:refs/heads/*"'
	t block "$wt" 'sh -c "git push origin main"'
	t block "$wt" 'git -C "$W" push'
	t allow "$wt" 'git push -u origin feat/a'
	t allow "$wt" 'git push --force-with-lease origin feat/a'
	t allow "$wt" 'git push'
	t allow "$wt" 'git push origin HEAD'
	t allow "$wt" 'git push origin v1.2.3'
	# a variable assigned earlier in the SAME command is resolved, not treated as unknown
	t allow "$tmp" "W=$wt; git -C \$W push"
	t block "$tmp" "W=$repo; git -C \$W push"
	t block "$tmp" "W=$repo && cd \$W && git push"

	# ── R-PUSH: tag deletes in every spelling, prune, and gh global flags (B1/B2) ──
	G -C "$repo" tag v1.0.0
	t block "$wt" 'git push --delete origin v1.0.0'
	t block "$wt" 'git push origin :v1.0.0'
	t block "$wt" 'git push origin --delete never-heard-of-it'
	t block "$wt" 'git push origin --tags --prune'
	t block "$wt" 'git push --prune origin "refs/tags/*:refs/tags/*"'
	t block "$wt" 'git push --prune --all origin'
	t block "$wt" 'git push --prune-tags origin'
	t block "$wt" 'git push --tags --force origin'
	t allow "$wt" 'git push origin --delete feat/a'
	t block "$wt" 'git push origin "refs/safety/*:refs/safety/*"'
	t block "$wt" 'git push origin refs/safety/wt-a/20261106T000000Z:refs/heads/feat/leak'
	t allow "$wt" 'git push origin :refs/heads/feat/old'
	t allow "$wt" 'git push --tags origin'
	t block "$wt" 'git push --prune origin "refs/heads/feat/*:refs/heads/feat/*"'

	# ── R-GH / R-GHAPI ──
	t block "$wt" 'gh repo delete alethialabs-io/app --yes'
	t block "$wt" 'gh repo archive'
	t block "$wt" 'gh repo rename new-name'
	t block "$wt" 'gh repo edit --visibility private'
	t block "$wt" 'gh release delete v1.0.0 --yes'
	t block "$wt" 'gh release delete-asset v1 file.tgz'
	t block "$wt" 'gh secret delete HCLOUD_TOKEN'
	t block "$wt" 'gh issue delete 12 --yes'
	t block "$wt" 'gh api -X DELETE repos/o/r/rulesets/1'
	t block "$wt" 'gh api --method PUT repos/o/r/branches/main/protection --input p.json'
	t block "$wt" 'gh api -X PATCH repos/o/r -f name=renamed'
	t block "$wt" 'gh api -XDELETE /repos/o/r/git/refs/heads/main'
	t block "$wt" 'gh api -X DELETE repos/o/r/releases/42'
	t block "$wt" 'gh api -X DELETE /orgs/o/packages/container/x'
	t block "$wt" 'gh api -X DELETE repos/o/r/environments/production'
	t block "$wt" 'gh api -X DELETE repos/o/r/hooks/7'
	t block "$wt" 'gh api -X DELETE repos/o/r/actions/secrets/FOO'
	t block "$wt" 'gh api -X DELETE repos/o/r'
	t block "$wt" 'gh api repos/o/r/transfer -f new_owner=x'
	t block "$wt" "gh api graphql -f query='mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }'"
	t block "$wt" 'gh api graphql --input q.json'
	t allow "$wt" 'gh api repos/o/r/rulesets'
	# gh's global flags before the subcommand (B1)
	t block "$wt" 'gh -R o/r release delete v1 --yes'
	t block "$wt" 'gh --repo o/r secret delete FOO'
	t block "$wt" 'gh --repo=o/r repo delete --yes'
	t block "$wt" 'gh -Ro/r issue delete 5 --yes'
	t block "$wt" 'gh --hostname github.com -R o/r api -X DELETE repos/o/r/rulesets/1'
	t allow "$wt" 'gh -R o/r release list'
	t allow "$wt" 'gh --repo o/r pr view 12'
	# a full URL is the same path; a graphql body from a file cannot be read
	t block "$wt" 'gh api -X DELETE https://api.github.com/repos/o/r'
	t block "$wt" 'gh api -X DELETE https://ghe.example.com/api/v3/repos/o/r/rulesets/2'
	t block "$wt" 'gh api graphql -F query=@mutation.graphql'
	t allow "$wt" 'gh api graphql -F owner=o -f query=query{viewer{login}}'
	t allow "$wt" 'gh api -X PATCH repos/o/r/git/refs/heads/deps/npm-minor -f sha=abc -F force=true'
	t allow "$wt" 'R=repos/o/r; gh api -X PATCH $R/git/refs/heads/deps/x -f sha=abc'
	t block "$wt" 'R=repos/o/r; gh api -X PATCH $R/git/refs/heads/main -f sha=abc -F force=true'
	t block "$wt" 'gh api -X DELETE repos/o/r/git/refs/tags/v1.0.0'
	t block "$wt" 'gh api -X PATCH repos/o/r/git/refs/heads/$B -f sha=abc'
	t allow "$wt" 'gh api -X POST repos/o/r/issues/1/comments -f body=hi'
	t allow "$wt" "gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"x\"}) { thread { id } } }'"
	t allow "$wt" 'gh pr view 12'
	t allow "$wt" 'gh release list'
	t allow "$wt" 'gh secret list'

	# ── R-TFSTATE ──
	mkdir -p "$repo/infra/sandbox"
	printf '{}' >"$repo/infra/sandbox/terraform.tfstate"
	t block "$repo" 'git clean -fdx'
	t block "$repo" 'git clean -fX'
	t block "$repo" 'rm infra/sandbox/terraform.tfstate'
	t block "$repo" 'rm -f infra/sandbox/terraform.tfstate.backup'
	t block "$repo" 'rm -rf infra'
	t block "$repo" 'mv infra/sandbox/terraform.tfstate /tmp/x'
	t block "$repo" 'cp /tmp/empty.json infra/sandbox/terraform.tfstate'
	t block "$repo" 'echo "{}" > infra/sandbox/terraform.tfstate'
	t block "$repo" 'tofu -chdir=infra/sandbox state rm hcloud_server.sandbox'
	t block "$repo" 'terraform state mv a b'
	t block "$repo" 'tofu state push x.tfstate'
	t block "$repo" 'tofu -chdir=infra/gcp-e2e init -migrate-state'
	t block "$repo" 'tofu init -force-copy'
	t block "$repo" 'tofu workspace delete old'
	t allow "$repo" "git clean -fdx -e '*.tfstate*'"
	t allow "$repo" 'cp infra/sandbox/terraform.tfstate /tmp/state-backup.json'
	t allow "$repo" 'tofu -chdir=infra/sandbox state list'
	t allow "$repo" 'tofu -chdir=infra/sandbox plan -out=tfplan'
	t allow "$repo" 'tofu init -backend=false'
	t allow "$repo" 'grep -rn tfstate infra/'
	# bulk deleters (find / rsync) that can reach local state
	t block "$repo" "find . -name '*.tfstate' -delete"
	t block "$repo" 'find infra -type f -delete'
	t block "$repo" 'find infra -exec rm {} +'
	t block "$repo" 'rsync -a --delete /tmp/empty/ infra/'
	t allow "$repo" "find . -name '*.log' -delete"
	t allow "$repo" 'find /tmp/x -type f -delete'
	t allow "$repo" 'rsync -a --delete /tmp/a/ /tmp/b/'
	t allow "$repo" 'find infra -name "*.tf"'

	# ── R-DB ──
	t block "$wt" 'pnpm -F console db:reset'
	t block "$wt" 'pnpm -C apps/console run db:migrate'
	t block "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@prod.db.example.com:5432/a pnpm -F console db:reset'
	t block "$wt" 'export ALETHIA_DATABASE_URL=postgres://u:p@ep-x.neon.tech/a && pnpm -F console db:migrate'
	t block "$wt" 'ALETHIA_DATABASE_URL="$(aws secretsmanager get-secret-value --secret-id x)" pnpm -F console db:reset'
	t block "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@localhost/a?host=prod.example.com pnpm -F console db:reset'
	t block "$wt" 'cd apps/console && npx drizzle-kit push'
	t block "$wt" 'node --env-file=.env apps/console/scripts/reset.mjs'
	t block "$wt" 'pnpm -F console db:reencrypt' ALETHIA_DATABASE_URL=postgres://u:p@prod.example.com/a
	t allow "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@localhost:5432/a pnpm -F console db:reset'
	t allow "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@127.0.0.1:5432/a pnpm -C apps/console run db:migrate'
	t allow "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@[::1]:5432/a pnpm -F console db:reset'
	t allow "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@db:5432/a pnpm -F console db:migrate'
	t allow "$wt" 'pnpm -F console db:migrate' ALETHIA_DATABASE_URL=postgres://u:p@localhost/a
	t allow "$wt" 'pnpm -F console db:generate'
	t allow "$wt" 'pnpm -F console test'
	t allow "$wt" 'git commit -m "guard: refuse db:reset against a remote host"'
	t allow "$wt" 'gh pr create --title "x" --body "covers pnpm -F console db:reset"'

	# ── R-DOCKER ──
	t block "$wt" 'docker volume rm alethia_pgdata'
	t block "$wt" 'docker volume prune -f'
	t block "$wt" 'docker system prune -a --volumes'
	t block "$wt" 'docker rm -v alethia-postgres-1'
	t allow "$wt" 'docker volume rm scratch_vol'
	t allow "$wt" 'docker volume ls'
	t allow "$wt" 'docker ps'
	t allow "$wt" 'docker rm old-container'

	# ── R-CLOUD ──
	t block "$wt" 'hcloud server delete box'
	t block "$wt" 'hcloud --context tovr-prod server delete box'
	t block "$wt" 'hcloud --context alethia-console-prod volume delete v'
	t block "$wt" 'HCLOUD_TOKEN=abc hcloud --context alethia-e2e server delete box'
	t block "$wt" 'hcloud server rebuild box --image x'
	t allow "$wt" 'hcloud --context alethia-e2e server delete e2e-box'
	t allow "$wt" 'hcloud --context=alethia-sandbox server delete sandbox'
	t allow "$wt" 'HCLOUD_CONTEXT=alethia-e2e hcloud server delete e2e-box'
	t allow "$wt" 'hcloud server list'
	t block "$wt" 'aws ec2 terminate-instances --instance-ids i-1'
	t block "$wt" 'aws --profile x s3 rm s3://bucket/key'
	t block "$wt" 'aws s3 sync . s3://b --delete'
	t block "$wt" 'aws rds delete-db-instance --db-instance-identifier x'
	t allow "$wt" 'aws ec2 describe-instances'
	t allow "$wt" 'aws s3 ls'
	t block "$wt" 'gcloud compute instances delete vm-1 --zone x'
	t allow "$wt" 'gcloud compute instances list'
	t block "$wt" 'az group delete -n rg --yes'
	t allow "$wt" 'az group list'
	t block "$wt" 'aliyun ecs DeleteInstance --InstanceId i-1'
	t allow "$wt" 'aliyun ecs DescribeInstances'
	t allow "$wt" 'kubectl --context kind-alethia delete pod x'
	t allow "$wt" 'kubectl --context=gke-alethia-e2e-1 delete ns x'
	t block "$wt" 'kubectl --context prod delete ns x'
	t block "$wt" 'kubectl delete ns x'
	t allow "$wt" 'kubectl delete ns x' STUB_KUBE_CONTEXT=kind-dev
	t block "$wt" 'kubectl drain node-1'
	t block "$wt" 'kubectl apply -f x.yaml --prune -l app=x'
	t allow "$wt" 'kubectl apply -f x.yaml'
	t allow "$wt" 'kubectl get pods'
	t block "$wt" 'helm uninstall argo -n argocd'
	t allow "$wt" 'helm uninstall argo --kube-context kind-x'

	# ── R-CRED / R-GITDIR ──
	t block "$wt" 'rm -rf ~/.ssh'
	t block "$wt" 'rm ~/.aws/credentials'
	t block "$wt" 'rm -rf ~/.config'
	t block "$wt" 'rm -rf $HOME/.config/gcloud'
	t block "$wt" 'mv ~/.cloudflared /tmp/x'
	t block "$wt" 'rm -rf ~/.s*'
	t block "$wt" 'echo x > ~/.ssh/authorized_keys'
	t block "$wt" "rm -rf $repo"
	t block "$wt" "rm -rf $repo/.git"
	t block "$wt" "rm -rf $tmp"
	t allow "$wt" 'rm -rf ~/scratch'
	t allow "$wt" 'ls ~/.ssh'

	# ── heredoc bodies and multi-line quoted text are data, not commands ──
	t allow "$wt" "python3 - <<'EOF'
import os
s = 'tofu state rm x; git push origin main'
EOF"
	t allow "$wt" "cat > /tmp/notes.md <<EOF
rm -rf ~/.ssh
gh repo delete x
EOF"
	t block "$wt" "bash <<'EOF'
git push origin main
EOF"
	t block "$wt" "cat <<EOF | sh
gh repo delete x
EOF"
	t allow "$wt" 'gh issue comment 1 --body "Done.
hcloud server delete was run by the maintainer.
git push origin main is refused."'
	t allow "$wt" 'gh issue close 1 --comment "Remove them with \`hcloud ssh-key delete <id>\` in the e2e project."'
	t block "$wt" 'echo "x `hcloud server delete box` y"'
	t allow "$wt" 'gh pr create --body "a \"quoted\" word
hcloud server delete box
done"'
	t block "$wt" 'gh pr create --body "a \"quoted\" word" && git push origin main'
	t block "$wt" "read x <<<word
git push origin main"
	t block "$wt" "cat > /tmp/x <<EOF
data
EOF
git push origin main"

	# ── inspection and the ordinary path ──
	t allow "$wt" 'grep -n "git push origin main" CLAUDE.md'
	t allow "$wt" 'echo "gh repo delete is refused"'
	t allow "$wt" "rg 'docker volume prune' docs"
	t allow "$wt" 'git status --short'
	t allow "$wt" 'git log --oneline -5'
	t allow "$wt" 'pnpm build'
	t allow "$wt" 'ls -la'
	t allow "$wt" 'rm -rf /tmp/some-scratch-dir'

	# ── S-TREE: the snapshot, exercised for real ──
	printf 'two\n' >"$wt/file.txt"
	printf 'new\n' >"$wt/untracked.txt"
	snapped 1 'reset --hard saves the tree first' "$wt" 'git reset --hard'
	local r
	r="$NEW"
	check 'the snapshot holds the MODIFIED tracked file' test "$(git -C "$repo" show "$r:file.txt" 2>/dev/null)" = two
	check 'the snapshot holds the UNTRACKED file' test "$(git -C "$repo" show "$r:untracked.txt" 2>/dev/null)" = new
	check 'the snapshot parent is HEAD' test "$(git -C "$repo" rev-parse "$r^" 2>/dev/null)" = "$(git -C "$wt" rev-parse HEAD)"
	check 'the real index is untouched (untracked file still untracked)' test -z "$(git -C "$wt" diff --cached --name-only)"
	case "$r" in refs/safety/wt-a/20[0-9][0-9][01][0-9][0-3][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z*) pass=$((pass + 1)) ;; *)
		fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
		echo "  ✗ ref name is refs/safety/<wt>/<UTC timestamp>: $r"
		;;
	esac
	git -C "$wt" checkout -- file.txt >/dev/null 2>&1
	rm -f "$wt/untracked.txt"
	snapped 0 'a clean tree stores nothing' "$wt" 'git reset --hard'
	mkdir -p "$wt/junk"
	printf 'j\n' >"$wt/junk/a.txt"
	snapped 1 'rm -rf of an untracked dir' "$wt" 'rm -rf junk'
	check 'that snapshot holds junk/a.txt' test "$(git -C "$repo" show "$NEW:junk/a.txt" 2>/dev/null)" = j
	snapped 1 'cd then rm resolves the tree' "$tmp" 'cd wt-a && rm -r junk'
	printf 'c\n' >"$wt/c.txt"
	snapped 1 'git clean -fd' "$wt" 'git clean -fd'
	snapped 0 'git clean -n is a dry run' "$wt" 'git clean -n'
	printf 'three\n' >"$wt/file.txt"
	snapped 1 'git checkout -- .' "$wt" 'git checkout -- .'
	snapped 1 'git restore .' "$wt" 'git restore .'
	snapped 1 'git switch --discard-changes' "$wt" 'git switch --discard-changes feat/a'
	snapped 1 'git -C <tree> checkout .' "$tmp" "git -C $wt checkout ."
	snapped 1 'git rm -f' "$wt" 'git rm -f file.txt'
	snapped 0 'git checkout -b creates, destroys nothing' "$wt" 'git checkout -b other'
	t block "$wt" 'git -C "$W" reset --hard'
	snapped 1 'rm -rf "$x" snapshots the cwd tree' "$wt" 'rm -rf "$x"'
	snapped 0 'rm outside any git tree' "$home" 'rm -rf scratch'

	# ── B5: worktree remove of a tree holding (ignored) local state ──
	G -C "$repo" worktree add -b feat/tf "$tmp/wt-tf"
	mkdir -p "$tmp/wt-tf/infra/sandbox"
	printf '{}' >"$tmp/wt-tf/infra/sandbox/terraform.tfstate"
	t block "$repo" "rm -rf $tmp/wt-tf"
	t block "$repo" "git worktree remove --force $tmp/wt-tf"
	t block "$repo" "git worktree remove $tmp/wt-tf"
	t block "$repo" 'git worktree remove --force "$WT"'
	rm -rf "$tmp/wt-tf/infra"

	# ── snapshot content never reaches a remote, by any route ──
	printf 'private-untracked\n' >"$wt/private.txt"
	snapped 1 'a snapshot of a tree holding a private untracked file' "$wt" 'git reset --hard'
	local snapref="$NEW" snapsha short
	snapsha="$(git -C "$repo" rev-parse "$snapref")"
	short="${snapref#refs/}"
	t block "$wt" "git push origin $short:refs/heads/recovered"
	t block "$wt" "git push origin $snapsha:refs/heads/recovered"
	G -C "$repo" branch from-snapshot "$snapsha"
	t block "$wt" 'git push -u origin from-snapshot'
	# a normal commit on top of the snapshot still carries it in its history
	G -C "$repo" worktree add "$tmp/wt-leak" from-snapshot
	printf 'more\n' >>"$tmp/wt-leak/file.txt"
	G -C "$tmp/wt-leak" commit -am 'work on top'
	t block "$tmp/wt-leak" 'git push'
	t block "$wt" 'git push origin from-snapshot:refs/heads/x'
	t allow "$wt" 'git push origin feat/a'
	# the NAME check still holds when the tree is unknown and nothing can be resolved
	t block "$wt" "git -C \"\$W\" push origin $snapref:refs/heads/x"
	# …and the restore the docs prescribe does NOT carry it: files onto the parent commit
	G -C "$repo" worktree add --detach "$tmp/wt-restored" "$snapsha^"
	G -C "$tmp/wt-restored" restore --source="$snapsha" --worktree -- .
	check 'the documented restore brings the private file back' test "$(cat "$tmp/wt-restored/private.txt" 2>/dev/null)" = private-untracked
	G -C "$tmp/wt-restored" switch -c restored-work
	G -C "$tmp/wt-restored" add -A
	G -C "$tmp/wt-restored" commit -m restored
	t allow "$tmp/wt-restored" 'git push -u origin restored-work'
	# .githooks/pre-push checks the exact range git sends — the layer no spelling can get past
	local bare="$tmp/remote.git" hooks="$REPO_ROOT/.githooks"
	git init -q --bare "$bare"
	git -C "$repo" remote add t "$bare" >/dev/null 2>&1
	if git -C "$repo" -c core.hooksPath="$hooks" push -q t from-snapshot:refs/heads/leak >/dev/null 2>"$tmp/push.err"; then
		bad_case 'pre-push refuses a branch whose history holds a snapshot commit'
	else pass=$((pass + 1)); fi
	check 'pre-push names the snapshot identity' grep -q 'snapshot' "$tmp/push.err"
	if git -C "$repo" -c core.hooksPath="$hooks" push -q t "$snapsha:refs/heads/leak2" >/dev/null 2>&1; then
		bad_case 'pre-push refuses a raw snapshot sha'
	else pass=$((pass + 1)); fi
	if git -C "$repo" -c core.hooksPath="$hooks" push -q t feat/a:refs/heads/feat/a >/dev/null 2>"$tmp/push.err"; then
		pass=$((pass + 1))
	else bad_case "pre-push lets an ordinary branch through: $(cat "$tmp/push.err")"; fi
	if git -C "$tmp/wt-restored" -c core.hooksPath="$hooks" push -q t restored-work >/dev/null 2>"$tmp/push.err"; then
		pass=$((pass + 1))
	else bad_case "pre-push lets the documented restore through: $(cat "$tmp/push.err")"; fi
	G -C "$repo" worktree remove --force "$tmp/wt-leak"
	G -C "$repo" worktree remove --force "$tmp/wt-restored"
	G -C "$repo" branch -D from-snapshot restored-work
	rm -f "$wt/private.txt"

	# ── S-WTREE ──
	G -C "$repo" worktree add -b feat/b "$tmp/wt-b"
	printf 'lost?\n' >"$tmp/wt-b/precious.txt"
	snapped 1 'worktree remove --force' "$repo" "git worktree remove --force $tmp/wt-b"
	case "$NEW" in refs/safety/wt-b/*) pass=$((pass + 1)) ;; *)
		fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
		echo "  ✗ a removed worktree is filed under its own name: $NEW"
		;;
	esac
	check 'the removed tree survives in refs/safety/wt-b' test "$(git -C "$repo" show "$NEW:precious.txt" 2>/dev/null)" = 'lost?'
	snapped 0 'worktree remove (no force) refuses dirty trees itself' "$repo" "git worktree remove $tmp/wt-b"

	# ── B4: the snapshot is bounded, and fair ──
	# helper: is <path> in the snapshot NEW?
	insnap() { git -C "$repo" cat-file -e "$NEW:$1" 2>/dev/null; }
	mkdir -p "$wt/.pnpm-store/v3" "$wt/node_modules/x" "$wt/small"
	printf 'store\n' >"$wt/.pnpm-store/v3/blob"
	printf 'dep\n' >"$wt/node_modules/x/index.js"
	printf 'mine\n' >"$wt/small/keep.txt"
	snapped 1 'a tree with dependency caches still snapshots' "$wt" 'git reset --hard'
	check 'the work file is in it' insnap small/keep.txt
	check '.pnpm-store is never captured' bash -c "! git -C '$repo' cat-file -e '$NEW:.pnpm-store/v3/blob' 2>/dev/null"
	check 'node_modules is never captured' bash -c "! git -C '$repo' cat-file -e '$NEW:node_modules/x/index.js' 2>/dev/null"
	rm -rf "$wt/.pnpm-store" "$wt/node_modules" "$wt/small"

	# A TRACKED change is always captured, even under a cache-named path (the excludes are for
	# untracked content only).
	mkdir -p "$wt/vendor/node_modules/pkg" "$wt/src" "$wt/flood"
	printf 'v1\n' >"$wt/vendor/node_modules/pkg/index.js"
	printf 'keep\n' >"$wt/src/keep.ts"
	printf 'keep\n' >"$wt/flood/keep"
	G -C "$wt" add -f vendor/node_modules/pkg/index.js src/keep.ts flood/keep
	G -C "$wt" commit -m 'tracked fixtures'
	printf 'v2-tracked-change\n' >"$wt/vendor/node_modules/pkg/index.js"
	snapped 1 'a tracked change under a cache-named path' "$wt" 'git checkout -- file.txt'
	check 'that tracked change is in the snapshot' test "$(git -C "$repo" show "$NEW:vendor/node_modules/pkg/index.js" 2>/dev/null)" = v2-tracked-change
	G -C "$wt" checkout -- vendor/node_modules/pkg/index.js

	# FAIRNESS: a big untracked directory that sorts FIRST, a 10-byte real file under src/ (a
	# tracked directory), and a small untracked directory that sorts after the big one.
	mkdir -p "$wt/aaa-data" "$wt/zzz-new"
	(cd "$wt/aaa-data" && touch f{0001..6000}) 2>/dev/null
	printf '0123456789' >"$wt/src/new.ts"
	printf 'note\n' >"$wt/zzz-new/note.md"
	snapped 1 'a big directory sorting first still snapshots' "$wt" 'git reset --hard'
	check 'the 10-byte file under src/ is captured' insnap src/new.ts
	check 'the small directory after the big one is captured' insnap zzz-new/note.md
	check 'the note names the big directory as cut at its share' grep -q 'aaa-data/ (cut at its share' "$tmp/stderr"
	check 'the note does not claim src/ was left out' bash -c "! grep -q 'src/' '$tmp/stderr'"
	rm -rf "$wt/aaa-data" "$wt/zzz-new" "$wt/src/new.ts"

	# SMALLEST FIRST among loose files: 5000 two-byte files and one 1-byte file that sorts LAST.
	perl -e 'for my $i (1 .. 5000) { open(my $f, ">", sprintf("%s/src/bulk-%04d", $ARGV[0], $i)) or die; print $f "xx"; close $f }' "$wt"
	printf 'z' >"$wt/src/zz-small.ts"
	snapped 1 'over the file budget it still snapshots' "$wt" 'git checkout -- file.txt'
	check 'the smallest file is taken first' insnap src/zz-small.ts
	check 'exactly the file budget was taken' test "$(git -C "$repo" diff --name-only --diff-filter=A "$NEW^" "$NEW" | wc -l | tr -d ' ')" = 5000
	check 'the note names the loose group left out' grep -q 'src/ (loose files) (over the cap)' "$tmp/stderr"
	rm -f "$wt"/src/bulk-* "$wt/src/zz-small.ts"

	# the BYTE budget: a 60 MB file in its own directory is left out, a small directory kept
	mkdir -p "$wt/big" "$wt/small"
	dd if=/dev/zero of="$wt/big/blob.bin" bs=1048576 count=60 2>/dev/null
	printf 'mine\n' >"$wt/small/keep.txt"
	snapped 1 'over the byte budget it still snapshots' "$wt" 'git checkout -- file.txt'
	check 'the big file is left out' bash -c "! git -C '$repo' cat-file -e '$NEW:big/blob.bin' 2>/dev/null"
	check 'the small file is still in' insnap small/keep.txt
	check 'the note names the big directory' grep -q 'big/ (over the cap)' "$tmp/stderr"
	rm -rf "$wt/big" "$wt/small"

	# more directories than SNAP_MAX_DIRS: every one past the limit is NAMED
	local d
	for d in $(seq -w 1 52); do mkdir -p "$wt/d$d" && printf 'x\n' >"$wt/d$d/f"; done
	snapped 1 'more directories than the scan limit' "$wt" 'git checkout -- file.txt'
	check 'a directory inside the limit is captured' insnap d01/f
	check 'the 51st directory is named as not scanned' grep -q 'd51/ (not scanned' "$tmp/stderr"
	check 'the 52nd directory is named as not scanned' grep -q 'd52/ (not scanned' "$tmp/stderr"
	rm -rf "$wt"/d[0-9][0-9]

	# the LISTING stops: 20500 loose files inside a tracked directory
	(cd "$wt/flood" && touch g{00001..20500}) 2>/dev/null
	snapped 1 'a flood of untracked files still snapshots' "$wt" 'git checkout -- file.txt'
	check 'the note says where the listing stopped' grep -q 'everything listed after flood/' "$tmp/stderr"
	find "$wt/flood" -name 'g*' -type f -delete

	# ── S-STASH / S-BRANCH ──
	printf 's1\n' >"$wt/file.txt"
	G -C "$wt" stash push -m one
	printf 's2\n' >"$wt/file.txt"
	G -C "$wt" stash push -m two
	local s0
	s0="$(git -C "$wt" rev-parse 'stash@{0}')"
	snapped 1 'stash drop pins stash@{0}' "$wt" 'git stash drop'
	check 'the pin IS the stash entry' test "$(git -C "$repo" rev-parse "$NEW")" = "$s0"
	case "$NEW" in refs/safety/wt-a/*-stash-0) pass=$((pass + 1)) ;; *)
		fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
		echo "  ✗ the stash pin is named …-stash-0: $NEW"
		;;
	esac
	snapped 2 'stash clear pins every entry' "$wt" 'git stash clear'
	snapped 1 'branch -D pins the tip' "$repo" 'git branch -D doomed'
	check 'the branch pin is the branch tip' test "$(git -C "$repo" rev-parse "$NEW")" = "$(git -C "$repo" rev-parse doomed)"
	snapped 0 'branch -d is safe' "$repo" 'git branch -d doomed'

	echo "  ${pass} passed, ${fail} failed"
	[ "$fail" -eq 0 ]
}

mutation_test() {
	local self="$1" dir ids id killed=0 survived=0 copy
	dir="$(mktemp -d)"
	trap 'rm -rf "$dir"' EXIT
	mkdir -p "$dir/lib"
	cp "${self%/*}/lib/cmdline.sh" "$dir/lib/"
	ids="$(grep -vE '^[[:space:]]*#' "$self" | grep -oE '(refuse|snapshot|snap|pin) [RS]-[A-Z]+' | awk '{print $2}' | sort -u)"
	for id in $ids; do
		copy="$dir/guard-destroy.sh"
		sed -E "s/(refuse|snapshot|snap|pin) $id( |\$)/true $id\\2/g" "$self" >"$copy"
		if SELFTEST_FAILFAST=1 HOOK_ROOT="$(cd "${self%/*}/../.." && pwd)" bash "$copy" --self-test >/dev/null 2>&1; then
			survived=$((survived + 1))
			echo "  ✗ mutant SURVIVED: disabling $id fails no self-test case"
		else
			killed=$((killed + 1))
			echo "  ✓ disabling $id fails the self-test"
		fi
	done
	# Targeted mutants: each `# @mut <name>` line disables the statement on the next line (its first
	# word becomes `true`); `# @mut-sub <name> <s///>` rewrites the next line. A marker must sit on
	# a REFUSAL or a call — never on `[ … ] && refuse`, where `true … && refuse` still refuses and the
	# mutant would only ever be "killed" by refusing too much. They cover the fixes a
	# whole-rule mutant cannot isolate (one site of a rule that has many).
	local names name lib="${self%/*}/lib/cmdline.sh" prepush
	prepush="$(cd "${self%/*}/../.." && pwd)/.githooks/pre-push"
	mkdir -p "$dir/root/.githooks"
	names="$(cat "$self" "$lib" "$prepush" | grep -oE '# @mut(-sub)? [a-z0-9-]+' | awk '{print $3}' | sort -u)"
	for name in $names; do
		cp "$self" "$dir/guard-destroy.sh"
		cp "$lib" "$dir/lib/cmdline.sh"
		cp "$prepush" "$dir/root/.githooks/pre-push"
		mutate_marker "$name" "$dir/guard-destroy.sh" "$dir/lib/cmdline.sh" "$dir/root/.githooks/pre-push"
		if cmp -s "$self" "$dir/guard-destroy.sh" && cmp -s "$lib" "$dir/lib/cmdline.sh" && cmp -s "$prepush" "$dir/root/.githooks/pre-push"; then
			survived=$((survived + 1))
			echo "  ✗ marker $name did not apply"
			continue
		fi
		if SELFTEST_FAILFAST=1 HOOK_ROOT="$dir/root" bash "$dir/guard-destroy.sh" --self-test >/dev/null 2>&1; then
			survived=$((survived + 1))
			echo "  ✗ mutant SURVIVED: disabling @$name fails no self-test case"
		else
			killed=$((killed + 1))
			echo "  ✓ disabling @$name fails the self-test"
		fi
	done
	cp "${self%/*}/lib/cmdline.sh" "$dir/lib/"
	echo "  ${killed} mutants killed, ${survived} survived"
	[ "$survived" -eq 0 ] && [ "$killed" -gt 0 ]
}

# mutate_marker <name> <file>… — apply the marker <name> in place (see mutation_test).
mutate_marker() {
	local name="$1"
	shift
	perl -i -pe 'BEGIN { $n = shift @ARGV }
		if ($next) { if (defined $sub && length $sub) { eval $sub } else { s/^(\s*)\S+/$1true/ } $next = 0 }
		if (/^\s*# \@mut(-sub)? \Q$n\E(?:\s+(.*))?$/) { $next = 1; $sub = $2 }' "$name" "$@"
}

case "${1:-}" in
--self-test)
	_s="$_self"
	case "$_s" in /*) ;; *) _s="$PWD/$_s" ;; esac
	self_test "$_s"
	exit $?
	;;
--mutation-test)
	_s="$_self"
	case "$_s" in /*) ;; *) _s="$PWD/$_s" ;; esac
	mutation_test "$_s"
	exit $?
	;;
esac
main
