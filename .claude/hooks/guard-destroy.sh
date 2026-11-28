#!/usr/bin/env bash
# PreToolUse(Bash) guard: nothing an agent runs becomes UNRECOVERABLE — it is BACKED UP FIRST.
#
# The maintainer's ruling (2026-11-22): the harness stops refusing instructed actions. The one hard
# refusal left is spend beyond the budget (.claude/hooks/guard-spend.sh). For deletion the rule is
# "build mechanisms so you can interact with the whole gamma of alethia labs products and services
# without actually sabotaging it" — so this hook takes a backup of whatever a destructive command
# would destroy, and then lets the command run. A backup that FAILS refuses the command: an
# unprotected destruction is the one thing this file exists to prevent. A hook blocks in every
# permission mode, so this is the layer that holds when the classifier half (user settings) is
# relaxed or wrong.
#
# THREE KINDS OF RULE
#
#   BACK UP, THEN ALLOW (exit 0) — into ~/.alethia/backups/<kind>/<UTC timestamp>/ (mode 700),
#   with a MANIFEST of what ran, what was saved and how to restore it. `pnpm backups:ls` lists them.
#   Each B-rule refuses as the R-rule of the same name when its backup fails or cannot be taken.
#     B-PUSH     a push that can overwrite or delete a remote ref: any push to dev/staging/main, a
#                force push (-f, --force-with-lease, a `+` refspec) or a delete of ANY branch or
#                tag (a short name is looked up as both), --mirror, --all/--branches with force,
#                --prune with --all/--tags, --prune-tags, --tags --force, a wildcard refspec. The
#                refs the remote has are fetched into refs/safety/remote/<ts>/heads|tags/<name>
#                (kind remote-refs keeps the list). The server rulesets on dev/staging/main remain
#                the real control; this makes a push that got past them recoverable.
#     B-GH       gh repo delete|archive (metadata, `git clone --mirror`, every issue, PR and
#                release as JSON); gh repo rename and edit --visibility (metadata); gh release
#                delete|delete-asset (release JSON, the assets, the tag ref for --cleanup-tag);
#                gh issue delete (the issue and its comments).
#     B-GHAPI    gh api DELETE|PUT|PATCH on rulesets, branch protection, releases, git/refs,
#                packages, environments, hooks, tag protection, or the repo/org itself: a GET of
#                the same path first (a 404 means nothing exists yet). A repo DELETE is mirrored as
#                for gh repo delete. POST to /transfer or a branch rename: a GET of the target.
#     B-TFSTATE  removing or overwriting terraform state — rm/mv/cp-onto/truncate/shred/`>` of a
#                *.tfstate*, rm -r of a directory holding one, `git clean -x|-X` in a tree holding
#                one, `git worktree remove` of a tree holding one, `find … -delete` / `-exec rm`
#                that can reach one, `rsync --delete` onto one: the state files are copied out.
#                tofu|terraform state rm|mv|push|replace-provider, init -migrate-state|-force-copy,
#                workspace delete: the module's local state is copied, or when it has none,
#                `state pull` (of that workspace) is written to the backup by the hook itself.
#     B-DB       db:reset / db:migrate / db:reencrypt / db:backfill-* / drizzle-kit
#                push|drop|migrate|up / the reset|migrate scripts against a NON-LOCAL
#                ALETHIA_DATABASE_URL: pg_dump (custom format) of that database. Under
#                `pnpm creds <profile> --` the dump runs under the same profile. A local URL runs
#                as before, with no dump.
#     B-DOCKER   docker volume rm of an alethia volume, docker volume prune, docker system prune
#                --volumes, docker rm -v of an alethia container: each alethia volume it would
#                remove is tarred through a throwaway container.
#     B-CLOUD    hcloud server delete|rebuild in an alethia-* project that is not disposable: a
#                snapshot image. aws ec2 delete-volume: an EBS snapshot. kubectl delete outside a
#                kind-*/ *-e2e* context: the objects as YAML (manifests, not volume data). helm
#                uninstall outside one: `helm get all`.
#
#   ALLOW with no backup — nothing to lose, or the provider keeps the backup: other cloud deletes
#   (aws terminate/s3/kms/…, gcloud, az, aliyun), kubectl drain / replace --force / apply --prune,
#   rds delete-db-* WITHOUT --skip-final-snapshot (RDS takes the final snapshot), secretsmanager
#   delete-secret WITHOUT --force-delete-without-recovery (the recovery window is the backup),
#   gh secret delete of a value a credential profile holds, hcloud deletes in alethia-e2e /
#   alethia-sandbox, pushes that only fast-forward a feature branch.
#
#   REFUSE (exit 2) — nothing can be backed up, or the action is self-sabotage, not an instruction:
#     R-PUSH     publishing a snapshot — a push whose source is refs/safety/* (other than
#                refs/safety/remote/*, which are copies of refs the remote already had) or whose
#                unpushed history holds a commit written by the snapshot identity, or a push to
#                refs/safety/* — because a snapshot can hold untracked private files and this
#                repository is public. A push whose tree is an unexpanded variable, when it needs
#                a backup.
#     R-GH       gh secret delete|remove of a secret no credential profile holds (GitHub never
#                returns a secret's value, so it could never be put back: store it first with
#                `pnpm creds --set`, then delete). A release or issue delete without a literal
#                tag or number.
#     R-GHAPI    the same secret rule for gh api DELETE …/secrets/<name>; a graphql mutation that
#                deletes or rewrites repository state (a node id has no GET — use the REST
#                endpoint, which is backed up); a graphql query read from a file; a protected path
#                or method the guard cannot read (a variable).
#     R-TFSTATE  a state-deleting command whose tree or module is an unexpanded variable.
#     R-DB       a database command whose URL the guard cannot derive (none visible, a variable, an
#                --env-file/dotenv the guard cannot read): prefix the literal URL or run it under
#                `pnpm creds <profile> --`, and it is dumped first.
#     R-DOCKER   a volume name the guard cannot read.
#     R-CLOUD    hcloud outside an alethia-* context or with an HCLOUD_TOKEN prefix (scope: the
#                default context on this Mac is ANOTHER company's production); hcloud volume
#                delete (Hetzner has no volume snapshot API); aws rds delete-db-* with
#                --skip-final-snapshot; aws secretsmanager delete-secret with
#                --force-delete-without-recovery; a volume id, release name or object the guard
#                cannot read.
#     R-CRED     rm/mv/shred/truncate/`>` of ~/.aws ~/.ssh ~/.config/gcloud ~/.cloudflared ~/.kube
#                ~/.config/hcloud, or of any directory that contains one. Kept on purpose: an agent
#                is never instructed to destroy the credentials it works with, and a copy of them
#                in a backup directory would be a second place for them to leak from.
#     R-GITDIR   rm of the repository's .git directory, or of any directory that contains it. Kept
#                on purpose: the refs/safety/ snapshots and remote-ref backups live there, so this
#                is the one deletion that would destroy the backups themselves.
#   Every B-rule also refuses when its backup fails (network, auth, a missing client tool, the time
#   budget below): "R-<rule>: could not back up before …", and nothing runs.
#
#   SNAPSHOT, THEN ALLOW (exit 0) — local git destruction, made recoverable with no friction:
#     S-TREE     git reset --hard · git clean (not -n) · git checkout (any form but -b/-B/--orphan)
#                · git switch -f|--discard-changes · git restore · git rm -f
#     S-RM       rm of a path inside a git work tree
#     S-WTREE    git worktree remove --force <path>
#     S-STASH    git stash drop|clear — pins the entries it would drop
#     S-BRANCH   git branch -D / --delete --force — pins the tips it would drop
#
#   THE BACKUP'S OWN COMMANDS run inside the hook, with their output going to files in the backup
#   directory, never to the transcript (a `state pull` or a pg_dump holds secrets; guard-secrets.sh
#   refuses `state pull` as an AGENT command for that reason). They are bounded by one budget,
#   BK_BUDGET (540 s), under the 600 s hook timeout set in .claude/settings.json and
#   .codex/hooks.json: a hook the harness kills ALLOWS the command, so a backup that would take too
#   long must be refused by the hook, never cut off by the harness. A command wrapped in
#   `pnpm creds <profile> --` is judged as the command it runs, and a backup that needs the same
#   access (state pull, pg_dump) runs under the same profile, writing its file from inside the
#   child so the broker's redactor never rewrites the backup.
#
#   A snapshot captures the tree's tracked AND untracked non-ignored content: copy the real index
#   to a temp GIT_INDEX_FILE (so unchanged files are not re-hashed), `git add -u` for the tracked
#   changes, then the untracked files UP TO A CAP, `write-tree`, `commit-tree` with HEAD as parent,
#   and store it at
#       refs/safety/<worktree-name>/<UTC timestamp>
#   Objects and refs/safety/* live in the SHARED repository, so they outlive the worktree's own
#   deletion. Nothing is stored when the tree already equals HEAD. session-cleanup.sh prunes
#   refs/safety entries older than 30 days — the snapshots, and the refs/safety/remote/<ts>/…
#   backups, whose timestamp sits in the same place. Nothing prunes ~/.alethia/backups/.
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
#       pnpm backups:ls                                           # ~/.alethia/backups, newest first
#       cat ~/.alethia/backups/<kind>/<ts>/MANIFEST               # what ran, what was saved, how back
#       git push origin +refs/safety/remote/<ts>/heads/<b>:refs/heads/<b>   # a remote ref put back
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
#     effort, and no tfstate under it is copied) and allowed — `rm -rf "$tmp"` is too common to
#     refuse. A git command whose TREE is
#     an unexpanded variable (`git -C "$W" reset --hard`) is refused: it cannot be snapshotted.
#   · ignored files (.env, node_modules, build output) are never in a snapshot; only tfstate,
#     which has no other copy, is copied out (B-TFSTATE).
#   · ~/.alethia/backups and refs/safety/ are on THIS Mac: they survive an agent's mistake, not
#     the loss of the machine. A backup is as complete as its API: a repo export is a record that
#     GitHub cannot re-import, a kubectl export saves manifests and not volume data, and a GitHub
#     secret's value is never readable (hence R-GH).
#   · a backup whose target is too big for the time budget (a huge repo mirror, a large database)
#     is refused, not taken in the background; take that one yourself and say so.
#   · `git reflog expire`, `git gc --prune=now`, `git update-ref -d`, `git branch -M` overwriting
#     a branch, `git filter-repo`: local history surgery, rare, not matched.
#   · psql/SQL text run against a remote database; DB URLs set in a shell profile the hook
#     process does not inherit.
#   · `docker rm -v` of a container not named alethia* (it only removes ANONYMOUS volumes; the
#     compose stack's named volumes survive it).
#   · gh api calls whose path or method is in a variable are refused only when the path is
#     recognisably protected.
#
# There is NO escape hatch here, and none is needed: anything that can be backed up is allowed after
# its backup, every refusal about a backup says what would let it through, and the two that do not
# (R-CRED, R-GITDIR) are self-sabotage rather than an instruction anyone gives.
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
		echo "  (guard-destroy backs up what a command destroys, then allows it; it refuses only what it cannot back up. See its header.)"
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

# bk_tfstate <path>… — copy every terraform state file at or under each path (a file, or a
# directory searched BK_TF_DEPTH (5) levels deep, one deeper than tree_has_tfstate looks; unlimited
# when BK_TF_DEPTH is empty) to $BK/files/<absolute path>. `.terraform/` (backend configuration,
# rebuilt by init) and node_modules are skipped. No state there: nothing to save, the command runs.
BK_TF_DEPTH=5
bk_tfstate() {
	local p f n=0 dirs=() rc
	: >"$BK/.list"
	for p in "$@"; do
		if [ -d "$p" ]; then
			dirs+=("$p")
		elif [ -f "$p" ]; then
			printf '%s\n' "$p" >>"$BK/.list"
		fi
	done
	if [ ${#dirs[@]} -gt 0 ]; then
		# find exits 1 on an unreadable subdirectory, which is not a failure to copy what it found;
		# running out of time is (bk_exec reports 142).
		bk_exec "$BK/.found" find "${dirs[@]}" ${BK_TF_DEPTH:+-maxdepth "$BK_TF_DEPTH"} -type f \
			\( -name '*.tfstate' -o -name '*.tfstate.*' \) -not -path '*/node_modules/*' -not -path '*/.terraform/*'
		rc=$?
		[ "$rc" = 0 ] || [ "$rc" = 1 ] || return 1
		cat "$BK/.found" >>"$BK/.list"
		rm -f "$BK/.found"
	fi
	while IFS= read -r f; do
		[ -f "$f" ] || continue
		if ! { mkdir -p "$BK/files${f%/*}" && cp -p "$f" "$BK/files$f"; } 2>/dev/null; then
			BK_ERR="could not copy $f"
			return 1
		fi
		printf '%s\n' "$f" >>"$BK/files.txt"
		n=$((n + 1))
	done <"$BK/.list"
	rm -f "$BK/.list"
	if [ "$n" -eq 0 ]; then
		BK_EMPTY=1
		BK_SAVED="no terraform state there"
		return 0
	fi
	BK_SAVED="$n terraform state file(s) (files.txt)"
	BK_RESTORE="cp -p $BK/files/<absolute path> <absolute path>"
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

# ── the backup: everything that is not a local git tree ───────────────────────────────────────
# A backup lands in ~/.alethia/backups/<kind>/<UTC timestamp>/ (mode 700), with a MANIFEST saying
# what ran, what was saved and how to put it back. `pnpm backups:ls` lists them. The hook's own
# commands below run INSIDE the hook: their output goes to files there, never to the transcript.
#
# Every external command is bounded by BK_SECS_LEFT, a budget for the whole hook that stays under
# the hook timeout in .claude/settings.json and .codex/hooks.json (600 s). A hook that is killed by
# its timeout ALLOWS the command (crash direction is fail-open), so a backup that would outlive the
# hook must be refused by the hook itself, never cut off by the harness.
BK_BUDGET=540
BK_START="$(date +%s)"

# bk_ts — a fresh UTC timestamp, the same format as the snapshot refs.
bk_ts() { date -u +%Y%m%dT%H%M%SZ; }

# bk_mask <text> — sets MASKED: the text with any URL password replaced, so a connection string in
# an error or a MANIFEST never carries one.
bk_mask() {
	MASKED="$(printf '%s' "$1" | sed -E 's#(://[^/@:[:space:]]*):[^/@[:space:]]+@#\1:***@#g')"
}

# bk_exec <stdout-file> <command…> — run one backup step with the time that is left. stdout goes to
# the file (/dev/null when the step writes its own); stderr is kept only to explain a failure.
bk_exec() {
	local out="$1" left rc err
	shift
	left=$((BK_BUDGET - ($(date +%s) - BK_START)))
	if [ "$left" -lt 5 ]; then
		BK_ERR="the hook's ${BK_BUDGET}s backup budget ran out before \`$1\`"
		return 1
	fi
	# from the command's own directory, so a relative path or gh's repository resolves as it will
	perl -e 'my $d = shift @ARGV; chdir $d if length $d && -d $d; alarm shift @ARGV; exec @ARGV or exit 127' \
		"${DIR:-}" "$left" "$@" >"$out" 2>"$BK/.stderr"
	rc=$?
	if [ "$rc" -ne 0 ]; then
		err="$(tail -c 400 "$BK/.stderr" 2>/dev/null | tr '\n' ' ')"
		case "$rc" in 127) err="not installed or not runnable. $err" ;; 142) err="timed out after ${left}s. $err" ;; esac
		bk_mask "\`$1\` failed (exit $rc): $err"
		BK_ERR="$MASKED"
	fi
	rm -f "$BK/.stderr"
	return "$rc"
}

# bk_wrapped <stdout-file> <command…> — bk_exec, run the way the agent's command will run: with the
# literal VAR=value prefixes it carried, and under `pnpm creds <profile> --` when it was wrapped in
# the credential broker. Under the broker the child writes the file ITSELF, so the redactor (which
# rewrites the child's stdout) never touches the backup's bytes.
bk_wrapped() {
	local out="$1" line envs=()
	shift
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		cmdline_has_var "$line" && continue
		line="${line//\"/}"
		envs+=("${line//\'/}")
	done <<<"$SEG_ENV"
	if [ -n "$CREDS_PROFILE" ]; then
		bk_exec /dev/null python3 "$CREDS_PY" "$CREDS_PROFILE" -- \
			env "${envs[@]}" sh -c 'o="$1"; shift; exec "$@" >"$o"' sh "$out" "$@"
	else
		bk_exec "$out" env "${envs[@]}" "$@"
	fi
}

# backup <B-RULE> <kind> <what> <fn> [args…] — make a backup directory, run <fn> to fill it, write
# its MANIFEST, and let the command through. A failed backup REFUSES as R-<RULE>: an unprotected
# destruction is exactly what this file exists to prevent. <fn> sets BK_SAVED (what it saved),
# BK_RESTORE (how to put it back), BK_ERR (why it failed), or BK_EMPTY=1 when there was nothing to
# save (the directory is then removed and the command allowed).
backup() {
	local id="$1" kind="$2" what="$3" fn="$4" dir ts
	shift 4
	ts="$(bk_ts)"
	dir="$HOME/.alethia/backups/$kind/$ts"
	[ -e "$dir" ] && dir="$dir-$$-$RANDOM"
	if ! (umask 077 && mkdir -p "$dir") 2>/dev/null; then
		refuse "R-${id#B-}" "could not create the backup directory $dir before \`$what\`." \
			"Nothing was run. A destruction without its backup is the one thing this guard refuses."
	fi
	chmod 700 "$HOME/.alethia/backups" "$HOME/.alethia/backups/$kind" 2>/dev/null
	# BK_TS names refs as well as the directory, so two backups in one second never share a name
	BK="$dir" BK_TS="${dir##*/}" BK_ERR="" BK_SAVED="" BK_RESTORE="" BK_EMPTY=""
	if ! "$fn" "$@"; then
		rm -rf "$dir"
		# @mut backup-fail
		refuse "R-${id#B-}" "could not back up before \`$what\`${BK_ERR:+ — $BK_ERR}." \
			"Nothing was run. Fix what the backup needs (network, auth, a client tool, or a smaller target) and run it again; the guard backs up first and then lets it through."
	fi
	if [ -n "$BK_EMPTY" ]; then
		rm -rf "$dir"
		note "nothing to back up before \`$what\` (${BK_SAVED:-the target holds nothing})."
		return 0
	fi
	bk_mask "$(printf 'kind: %s\nwhen: %s\nrule: %s\nwhat: %s\ncwd: %s\nsaved: %s\nrestore: %s\ncommand:\n%s' \
		"$kind" "$ts" "$id" "$what" "${DIR:-?}" "$BK_SAVED" "${BK_RESTORE:-see the files in this directory}" "$CMD")"
	printf '%s\n' "$MASKED" >"$dir/MANIFEST" 2>/dev/null
	note "backed up before \`$what\` → $dir — $BK_SAVED${BK_RESTORE:+   (restore: $BK_RESTORE)}"
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

# ── B-DB / R-DB ───────────────────────────────────────────────────────────────────────────────
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
	*" db:reset"* | *" db:migrate"* | *" db:reencrypt"* | *" db:backfill-"* | *"drizzle-kit push"* | *"drizzle-kit drop"* | *"drizzle-kit migrate"* | *"drizzle-kit up"* | *"scripts/reset.mjs"* | *"scripts/migrate.mjs"* | *"reencrypt-secrets"*) ;;
	*) return 0 ;;
	esac
	env_lookup ALETHIA_DATABASE_URL
	# Under the credential broker the URL is in the CHILD's environment, which the guard cannot
	# see — but it can run pg_dump under the same broker, so the dump is of the same database.
	if [ "$ENV_SRC" != prefix ] && [ -n "$CREDS_PROFILE" ]; then
		backup B-DB db "$SEG" bk_db_dump ""
		return 0
	fi
	if [ "$ENV_SRC" != prefix ]; then
		case " $SEG " in *" --env-file"* | *" dotenv "*)
			refuse R-DB "\`$SEG\` loads its database URL from a file the guard cannot read, so it cannot dump that database first." \
				"Prefix the command with the literal URL (ALETHIA_DATABASE_URL=postgres://… <command>), or run it under the broker (pnpm creds <profile> -- <command>); the guard then pg_dumps that database to ~/.alethia/backups/db/ and lets it through."
			;;
		esac
	fi
	if [ -z "$ENV_VAL" ]; then
		refuse R-DB "\`$SEG\` drops or rewrites a database, and no ALETHIA_DATABASE_URL is visible to the guard, so it cannot dump that database first." \
			"Prefix the command with the literal URL, or run it under the broker (pnpm creds <profile> -- <command>). A local URL (localhost, 127.0.0.1, ::1, or the compose host db/postgres) runs as is; any other is pg_dumped first."
	fi
	if ! db_host "$ENV_VAL"; then
		refuse R-DB "\`$SEG\` targets a database URL the guard cannot parse (a variable, a substitution, or not a URL), so it cannot dump that database first." \
			"Prefix the command with the literal URL, or run it under the broker (pnpm creds <profile> -- <command>)."
	fi
	db_host_is_local "$DB_HOST" && return 0
	backup B-DB db "$SEG" bk_db_dump "$ENV_VAL"
}

# bk_db_dump <url|""> — pg_dump (custom format) the database the command targets. An empty URL
# means "the one the broker puts in ALETHIA_DATABASE_URL"; the child refuses to dump when the broker
# did not set it, rather than dumping whatever libpq's defaults point at.
bk_db_dump() {
	local url="$1"
	if [ -n "$url" ]; then
		bk_exec /dev/null pg_dump --format=custom --no-owner --file="$BK/db.dump" "$url" || return 1
		db_host "$url"
		BK_SAVED="pg_dump of the database at $DB_HOST (db.dump)"
	else
		bk_wrapped /dev/null sh -c '[ -n "$ALETHIA_DATABASE_URL" ] || { echo "the broker profile sets no ALETHIA_DATABASE_URL" >&2; exit 3; }; exec pg_dump --format=custom --no-owner --file="$1" "$ALETHIA_DATABASE_URL"' sh "$BK/db.dump" || return 1
		BK_SAVED="pg_dump of the database in profile '$CREDS_PROFILE' (db.dump)"
	fi
	[ -s "$BK/db.dump" ] || {
		BK_ERR="pg_dump wrote nothing"
		return 1
	}
	BK_RESTORE="pg_restore --clean --if-exists --no-owner -d <url> $BK/db.dump"
}

# ── B-PUSH / R-PUSH ───────────────────────────────────────────────────────────────────────────
current_branch() { # <dir> — sets BRANCH ("" when detached or unknown)
	BRANCH=""
	[ -n "$1" ] || return 1
	BRANCH="$(git -C "$1" symbolic-ref -q --short HEAD 2>/dev/null)"
}

# push_source_is_snapshot <src> — does pushing <src> publish snapshot content? True when <src>
# resolves (by any spelling: a short name git expands, a raw sha, a branch) to a ref under
# refs/safety/ (except refs/safety/remote/, which are copies of refs the remote already had), or
# to a commit whose history — beyond what the remotes already have — holds a commit written by the
# snapshot identity. A branch made from a snapshot is caught here too; .githooks/pre-push repeats
# the history check on the exact range git is about to send.
push_source_is_snapshot() {
	local src="$1" full sha
	[ -n "$GDIR" ] && [ -n "$src" ] || return 1
	full="$(git -C "$GDIR" rev-parse --symbolic-full-name "$src" 2>/dev/null)"
	case "$full" in refs/safety/remote/*) ;; refs/safety/*) return 0 ;; esac
	sha="$(git -C "$GDIR" rev-parse -q --verify "$src^{commit}" 2>/dev/null)" || return 1
	git -C "$GDIR" log --format='%ae %ce' "$sha" --not --remotes 2>/dev/null | grep -qF "$SNAP_EMAIL"
}

# push_backup_ref <dst> — add the remote ref(s) a push to <dst> could overwrite or delete to RREFS.
# A short name is resolved by the REMOTE, where it may be a branch or a tag, so both are recorded.
push_backup_ref() {
	local d="$1"
	case "$d" in
	refs/*) RREFS+=("$d") ;;
	heads/* | tags/*) RREFS+=("refs/$d") ;;
	*) RREFS+=("refs/heads/$d" "refs/tags/$d") ;;
	esac
}

# bk_remote_refs <dir> <remote> <ref-or-glob>… — copy every listed ref the remote HAS into the local
# repository as refs/safety/remote/<ts>/heads/<branch> or …/tags/<tag>. The timestamp comes first
# so session-cleanup.sh's 30-day prune (refs/safety/<name>/<ts>) reads its age the same way.
bk_remote_refs() {
	local dir="$1" remote="$2" sha ref specs=()
	shift 2
	bk_exec "$BK/ls-remote.txt" git -C "$dir" ls-remote "$remote" "$@" || return 1
	while read -r sha ref; do
		case "$ref" in
		*'^{}') ;;
		refs/heads/* | refs/tags/*) specs+=("+$ref:refs/safety/remote/$BK_TS/${ref#refs/}") ;;
		esac
	done <"$BK/ls-remote.txt"
	if [ ${#specs[@]} -eq 0 ]; then
		BK_EMPTY=1
		BK_SAVED="the remote has none of: $*"
		return 0
	fi
	bk_exec /dev/null git -C "$dir" fetch -q --no-tags --no-write-fetch-head "$remote" "${specs[@]}" || return 1
	printf '%s\n' "${specs[@]}" >"$BK/refs.txt"
	BK_SAVED="${#specs[@]} remote ref(s) under refs/safety/remote/$BK_TS/ (refs.txt)"
	BK_RESTORE="git push $remote +refs/safety/remote/$BK_TS/heads/<branch>:refs/heads/<branch> (a protected branch also needs the ruleset's bypass)"
}

# rule_push — pushes are ALLOWED once every remote ref they can overwrite or delete is copied
# under refs/safety/remote/. The server rulesets on dev/staging/main remain the real control; this
# makes a push that got past them recoverable. What stays refused is publishing a snapshot.
rule_push() {
	local i a remote="" force=0 del=0 all=0 prune=0 tags=0 mirror=0 n=${#GARGS[@]} specs=() skip=0 s src dst plus
	RREFS=()
	for ((i = 0; i < n; i++)); do
		a="${GARGS[$i]}"
		if [ "$skip" = 1 ]; then
			skip=0
			continue
		fi
		case "$a" in
		--mirror) mirror=1 ;;
		-f | --force | --force-with-lease* | --force-if-includes) force=1 ;;
		-d | --delete) del=1 ;;
		--all | --branches) all=1 ;;
		--prune) prune=1 ;;
		--tags) tags=1 ;;
		--prune-tags)
			# @mut prune-tags
			RREFS+=('refs/tags/*')
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
	# A snapshot holds whatever untracked files the tree had — local documents, .bak files — and
	# this repository is PUBLIC. Snapshots never leave the machine.
	for s in "${specs[@]}"; do
		s="${s#+}"
		src="${s%%:*}"
		case "$s" in *:*) dst="${s##*:}" ;; *) dst="$s" ;; esac
		case "$dst" in refs/safety/* | safety/*)
			# @mut push-safety
			refuse R-PUSH "\`git push\` to $dst would publish local snapshots, which can hold untracked private files."
			;;
		esac
		case "$src" in refs/safety/remote/*) ;; refs/safety/* | safety/*)
			refuse R-PUSH "\`git push\` of $src would publish a local snapshot, which can hold untracked private files." ;;
		esac
		if [ -n "$src" ] && push_source_is_snapshot "$src"; then
			# @mut push-snapshot-source
			refuse R-PUSH "\`git push\` of '$src' would publish a snapshot commit (a refs/safety ref under another name, or a history holding a commit written by the snapshot identity), which can carry untracked private files." \
				"Restore files from a snapshot onto a normal commit instead (.claude/skills/dev/SKILL.md → Recovering from a destructive command)."
		fi
	done
	[ "$mirror" = 1 ] && RREFS+=('refs/heads/*' 'refs/tags/*')
	[ "$all" = 1 ] && [ "$force" = 1 ] && RREFS+=('refs/heads/*')
	if [ "$prune" = 1 ]; then
		[ "$all" = 1 ] && RREFS+=('refs/heads/*')
		[ "$tags" = 1 ] && RREFS+=('refs/tags/*')
	fi
	if [ "$tags" = 1 ] && [ "$force" = 1 ]; then
		# @mut tags-force
		RREFS+=('refs/tags/*')
	fi
	if [ ${#specs[@]} -eq 0 ] && [ "$all" = 0 ] && [ "$mirror" = 0 ] && [ "$tags" = 0 ]; then
		# No refspec: git pushes the current branch (or, under push.default=upstream, to its
		# upstream). Resolve that here rather than leave it to the pre-push hook.
		[ -n "$GDIR" ] || refuse R-PUSH "cannot tell which branch a bare \`git push\` pushes (the tree is an unexpanded variable), so the remote branch cannot be backed up first." \
			"Spell the path literally (git -C <path> push)."
		current_branch "$GDIR"
		if push_source_is_snapshot HEAD; then
			# @mut push-snapshot-content
			refuse R-PUSH "\`git push\` would publish a snapshot commit: this branch's unpushed history holds a commit written by guard-destroy's snapshot identity, which can carry untracked private files." \
				"Restore files from a snapshot onto a normal commit instead (.claude/skills/dev/SKILL.md → Recovering from a destructive command)."
		fi
		dst="$BRANCH"
		case "$(git -C "$GDIR" config --get push.default 2>/dev/null)" in upstream | tracking)
			dst="$(git -C "$GDIR" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)"
			dst="${dst#*/}"
			;;
		esac
		if [ -n "$dst" ] && { [ "$force" = 1 ] || is_protected_branch "$dst"; }; then
			push_backup_ref "refs/heads/$dst"
		fi
	fi
	for s in "${specs[@]}"; do
		plus=0
		case "$s" in +*) plus=1 ;; esac
		s="${s#+}"
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
		[ -n "$dst" ] || continue
		# A wildcard can reach dev/staging/main; with --prune it also deletes what it matches.
		case "$dst" in *\**)
			RREFS+=("$dst")
			continue
			;;
		esac
		if [ "$del" = 1 ] || [ -z "$src" ] || [ "$force" = 1 ] || [ "$plus" = 1 ]; then
			# a delete or a forced update, of any ref: the remote's copy is what would be lost
			push_backup_ref "$dst"
		elif is_protected_branch "${dst#refs/heads/}"; then
			push_backup_ref "$dst"
		fi
	done
	[ ${#RREFS[@]} -gt 0 ] || return 0
	[ -n "$GDIR" ] || refuse R-PUSH "cannot tell which repository \`git push\` runs in (the tree is an unexpanded variable), so the remote refs it overwrites cannot be backed up first." \
		"Spell the path literally (git -C <path> push …)."
	if [ -z "$remote" ]; then
		current_branch "$GDIR"
		remote="$(git -C "$GDIR" config --get "branch.$BRANCH.remote" 2>/dev/null)"
		[ -n "$remote" ] || remote=origin
	fi
	backup B-PUSH remote-refs "git push ${GARGS[*]}" bk_remote_refs "$GDIR" "$remote" "${RREFS[@]}"
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
				refuse R-TFSTATE "cannot tell which tree \`$label\` cleans, and -x/-X deletes ignored files such as terraform.tfstate, which no snapshot can capture." \
					"Spell the path literally; the guard then copies the tree's state to ~/.alethia/backups/tfstate/ first."
			fi
			if find_top "$GDIR" && tree_has_tfstate "$TOP"; then
				case "$SEG" in *-e*tfstate*) ;; *)
					backup B-TFSTATE tfstate "$label" bk_tfstate "$TOP"
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
			refuse R-TFSTATE "cannot tell which tree \`$label\` removes, so neither its local state nor its work can be backed up first." \
				"Spell the path literally."
		fi
		cmdline_abspath "$target" "$GDIR"
		# Forced or not: plain `worktree remove` also deletes IGNORED files, and a snapshot can
		# never see them. Local tfstate has no other copy, so it is copied out first, as for `rm -r`.
		if [ -d "$ABSPATH" ] && tree_has_tfstate "$ABSPATH"; then
			# @mut wt-tfstate
			backup B-TFSTATE tfstate "$label" bk_tfstate "$ABSPATH"
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
		# Local state has no other copy (infra/*-e2e and infra/sandbox keep it on this machine, and
		# losing it orphans real cloud resources), and a snapshot cannot see an ignored file.
		if is_tfstate_path "$P"; then
			# @mut rm-tfstate
			backup B-TFSTATE tfstate "$prog $t" bk_tfstate "$P"
		elif [ "$recursive" = 1 ] && [ -d "$P" ] && tree_has_tfstate "$P"; then
			backup B-TFSTATE tfstate "$prog -r $t" bk_tfstate "$P"
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
			if is_tfstate_path "$P"; then
				# @mut mv-tfstate
				backup B-TFSTATE tfstate "mv $a" bk_tfstate "$P"
			fi
			for c in "${CREDS[@]}"; do
				path_overlaps "$P" "$c" && [ "$a" != "$last" ] && refuse R-CRED "\`mv $a\` moves a credential directory out of place."
			done
		fi
	done
	cmdline_has_var "$last" && return 0
	cmdline_abspath "$last" "${DIR:-/}"
	if is_tfstate_path "$ABSPATH" && [ ${#args[@]} -ge 2 ]; then
		# @mut cp-onto-tfstate
		backup B-TFSTATE tfstate "$prog … $last" bk_tfstate "$ABSPATH"
	fi
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
		if is_tfstate_path "$ABSPATH"; then
			# @mut redirect-tfstate
			backup B-TFSTATE tfstate "> $t" bk_tfstate "$ABSPATH"
		fi
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
		local named=0 paths=()
		case "$SEG" in *tfstate*) named=1 ;; esac
		# with a name or path filter that does not name state, the state is not what goes
		if [ "$named" = 0 ]; then
			case " $SEG " in *" -name "* | *" -iname "* | *" -path "* | *" -ipath "* | *" -regex "* | *" -iregex "*) return 0 ;; esac
		fi
		for a in "${TOK[@]:1}"; do
			case "$a" in -* | "(" | "!") break ;; esac
			roots+=("$a")
		done
		[ ${#roots[@]} -gt 0 ] || roots=(.)
		for a in "${roots[@]}"; do
			if cmdline_has_var "$a"; then
				[ "$named" = 1 ] && refuse R-TFSTATE "\`find $a … -delete\` deletes terraform state under a directory the guard cannot name, so it cannot copy the state out first." \
					"Spell the path literally."
				continue
			fi
			cmdline_abspath "$a" "${DIR:-/}"
			if [ "$named" = 1 ]; then
				paths+=("$ABSPATH")
			elif [ -d "$ABSPATH" ] && tree_has_tfstate "$ABSPATH"; then
				paths+=("$ABSPATH")
			fi
		done
		# a find that names state reaches it at any depth, so the copy does too
		[ "$named" = 1 ] && BK_TF_DEPTH=""
		if [ ${#paths[@]} -gt 0 ]; then
			# @mut find-tfstate
			backup B-TFSTATE tfstate "find … -delete" bk_tfstate "${paths[@]}"
		fi
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
		backup B-TFSTATE tfstate "rsync --delete … $last" bk_tfstate "$ABSPATH"
	fi
	return 0
}

rule_tofu() {
	local a nf=() chdir="" state="" what="" ws=""
	for a in "${TOK[@]:1}"; do
		case "$a" in
		-chdir=*) chdir="${a#-chdir=}" ;;
		-state=*) state="${a#-state=}" ;;
		-*) ;;
		*) nf+=("$a") ;;
		esac
	done
	case "${nf[0]:-}" in
	state)
		case "${nf[1]:-}" in rm | mv | push | replace-provider) what="${TOK[0]##*/} state ${nf[1]}" ;; esac
		;;
	init)
		case " ${TOK[*]} " in *" -migrate-state"* | *" -force-copy"*) what="${TOK[0]##*/} init -migrate-state/-force-copy" ;; esac
		;;
	workspace)
		if [ "${nf[1]:-}" = delete ]; then
			what="${TOK[0]##*/} workspace delete"
			ws="${nf[2]:-}"
		fi
		;;
	esac
	[ -n "$what" ] || return 0
	local mod="${DIR:-}"
	if [ -n "$chdir" ]; then
		mod=""
		if ! cmdline_has_var "$chdir"; then
			case "$chdir" in
			/*)
				cmdline_abspath "$chdir" /
				mod="$ABSPATH"
				;;
			*)
				if [ -n "$DIR" ]; then
					cmdline_abspath "$chdir" "$DIR"
					mod="$ABSPATH"
				fi
				;;
			esac
		fi
	fi
	if [ -z "$mod" ] || cmdline_has_var "$ws$state"; then
		refuse R-TFSTATE "cannot tell which module \`$what\` acts on (an unexpanded variable), so its state cannot be backed up first." \
			"Spell -chdir= (and the workspace) literally; the guard then copies or pulls the state into ~/.alethia/backups/tfstate/ and lets it through."
	fi
	if [ -n "$state" ]; then
		cmdline_abspath "$state" "$mod"
		state="$ABSPATH"
	fi
	backup B-TFSTATE tfstate "$what" bk_tofu_state "${TOK[0]}" "$mod" "$ws" "$state"
}

# bk_tofu_state <prog> <module-dir> <workspace|""> <-state file|""> — copy the module's LOCAL state
# (terraform.tfstate*, terraform.tfstate.d/, an explicit -state= file); when it has none, the
# backend's: `<prog> state pull` into state-pull.tfstate, run inside the hook with its output going
# straight to the file (guard-secrets refuses `state pull` as an agent command because it would
# print secrets; here it never reaches a transcript). TF_WORKSPACE selects the workspace a
# `workspace delete` would remove.
bk_tofu_state() {
	local prog="$1" mod="$2" ws="$3" state="$4" f local_state=()
	while IFS= read -r f; do
		[ -n "$f" ] && local_state+=("$f")
	done < <(compgen -G "$mod/*.tfstate*")
	[ -d "$mod/terraform.tfstate.d" ] && local_state+=("$mod/terraform.tfstate.d")
	[ -n "$state" ] && local_state+=("$state")
	bk_tfstate "${local_state[@]}" || return 1
	[ -n "$BK_EMPTY" ] || return 0
	BK_EMPTY=""
	if [ -n "$ws" ]; then
		bk_wrapped "$BK/state-pull.tfstate" env TF_WORKSPACE="$ws" "$prog" -chdir="$mod" state pull || return 1
	else
		bk_wrapped "$BK/state-pull.tfstate" "$prog" -chdir="$mod" state pull || return 1
	fi
	if [ ! -s "$BK/state-pull.tfstate" ]; then
		BK_EMPTY=1
		BK_SAVED="the backend holds no state for $mod${ws:+ (workspace $ws)}"
		return 0
	fi
	BK_SAVED="\`$prog state pull\` of $mod${ws:+ (workspace $ws)} (state-pull.tfstate)"
	BK_RESTORE="$prog -chdir=$mod state push -force $BK/state-pull.tfstate"
}

rule_docker() {
	local sub="${TOK[1]:-}" verb="${TOK[2]:-}" a vols=()
	case "$sub" in
	volume)
		case "$verb" in
		prune)
			backup B-DOCKER docker-volumes "docker volume prune" bk_docker_dangling
			;;
		rm | remove)
			for a in "${TOK[@]:3}"; do
				case "$a" in
				-*) ;;
				*'$'* | *'`'*)
					refuse R-DOCKER "\`docker volume $verb $a\` names a volume the guard cannot read, so it cannot be backed up first." \
						"Name the volume literally."
					;;
				*alethia*) vols+=("$a") ;;
				esac
			done
			if [ ${#vols[@]} -gt 0 ]; then
				backup B-DOCKER docker-volumes "docker volume $verb ${vols[*]}" bk_docker_volumes "${vols[@]}"
			fi
			;;
		esac
		;;
	system)
		[ "$verb" = prune ] && case " ${TOK[*]} " in *" --volumes"*)
			backup B-DOCKER docker-volumes "docker system prune --volumes" bk_docker_dangling
			;;
		esac
		;;
	rm | container)
		[ "$sub" = container ] && [ "$verb" != rm ] && return 0
		case " ${TOK[*]} " in *" -v"* | *" --volumes"* | *" -fv"*)
			for a in "${TOK[@]:2}"; do
				case "$a" in *alethia*)
					backup B-DOCKER docker-volumes "docker rm -v $a" bk_docker_container "$a"
					;;
				esac
			done
			;;
		esac
		;;
	esac
	return 0
}

# bk_docker_volumes <volume>… — tar each volume's contents into <volume>.tgz through a throwaway
# container (the volume is mounted read-only).
BK_DOCKER_IMAGE=alpine:3.20
bk_docker_volumes() {
	local v n=0
	for v in "$@"; do
		bk_exec /dev/null docker run --rm -v "$v:/v:ro" -v "$BK:/b" "$BK_DOCKER_IMAGE" tar czf "/b/$v.tgz" -C /v . || return 1
		n=$((n + 1))
	done
	if [ "$n" -eq 0 ]; then
		BK_EMPTY=1
		BK_SAVED="no alethia volume would be removed"
		return 0
	fi
	BK_SAVED="$n docker volume(s) as <volume>.tgz: $*"
	BK_RESTORE="docker volume create <v> && docker run --rm -v <v>:/v -v $BK:/b $BK_DOCKER_IMAGE tar xzf /b/<v>.tgz -C /v"
}

# bk_docker_dangling — a prune removes every UNUSED volume; the alethia ones among them are saved.
bk_docker_dangling() {
	local v vols=()
	bk_exec "$BK/.vols" docker volume ls -q --filter dangling=true || return 1
	while IFS= read -r v; do
		case "$v" in *alethia*) vols+=("$v") ;; esac
	done <"$BK/.vols"
	rm -f "$BK/.vols"
	bk_docker_volumes "${vols[@]}"
}

# bk_docker_container <container> — `docker rm -v` removes the container's anonymous volumes.
bk_docker_container() {
	local v vols=()
	bk_exec "$BK/.vols" docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$1" || return 1
	while IFS= read -r v; do
		[ -n "$v" ] && vols+=("$v")
	done <"$BK/.vols"
	rm -f "$BK/.vols"
	bk_docker_volumes "${vols[@]}"
}

# ── B-CLOUD / R-CLOUD ─────────────────────────────────────────────────────────────────────────
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

# flag_value <flag> — sets FV: the value of `<flag> v` or `<flag>=v` in TOK ("" when absent).
flag_value() {
	local i n=${#TOK[@]}
	FV=""
	for ((i = 1; i < n; i++)); do
		case "${TOK[$i]}" in
		"$1") FV="${TOK[$((i + 1))]:-}" ;;
		"$1"=*) FV="${TOK[$i]#*=}" ;;
		esac
	done
}

# aws_globals — sets AWSG: the --profile/--region/--endpoint-url the command carries, so the hook's
# own call reaches the same account and region.
aws_globals() {
	local f
	AWSG=()
	for f in --profile --region --endpoint-url; do
		flag_value "$f"
		[ -n "$FV" ] && AWSG+=("$f" "$FV")
	done
	return 0
}

# kube_globals — sets KUBEG: the context, kubeconfig and namespace flags, for the hook's own `get`.
kube_globals() {
	local i n=${#TOK[@]} a
	KUBEG=()
	for ((i = 1; i < n; i++)); do
		a="${TOK[$i]}"
		case "$a" in
		--context | --kube-context | --kubeconfig | -n | --namespace) KUBEG+=("$a" "${TOK[$((i + 1))]:-}") ;;
		--context=* | --kube-context=* | --kubeconfig=* | --namespace=* | -A | --all-namespaces) KUBEG+=("$a") ;;
		esac
	done
	return 0
}

rule_cloud() {
	local prog="$1"
	nonflag_words
	case "$prog" in
	hcloud)
		case "${NF[1]:-}" in delete | rebuild | delete-*) ;; *) return 0 ;; esac
		hcloud_context
		hcloud_disposable "$HCTX" && [ "$HTOKEN" = 0 ] && return 0
		# Scope, not recoverability: the default hcloud context on this Mac is ANOTHER company's
		# production, and a token overrides whatever project a context names.
		[ "$HTOKEN" = 1 ] && refuse R-CLOUD "\`hcloud ${NF[0]} ${NF[1]}\` with an HCLOUD_TOKEN prefix — the guard cannot tell which project it deletes in, and it may not be Alethia's."
		case "$HCTX" in alethia-*) ;; *)
			refuse R-CLOUD "\`hcloud ${NF[0]} ${NF[1]}\` outside an Alethia project (context '${HCTX:-<the global default>}')." \
				"The default hcloud context on this Mac is ANOTHER company's production. Name an alethia-* context with --context."
			;;
		esac
		case "${NF[0]}" in
		server)
			backup B-CLOUD hcloud "hcloud --context $HCTX server ${NF[1]} ${NF[2]:-}" bk_hcloud_server "$HCTX" "${NF[2]:-}"
			;;
		volume)
			# @mut hcloud-volume
			refuse R-CLOUD "\`hcloud --context $HCTX volume ${NF[1]}\` deletes a volume, and Hetzner has no volume snapshot API, so it cannot be backed up first." \
				"Copy the data off the volume first (attach it, then pg_dump / tar it into ~/.alethia/backups/), or delete it in the Hetzner console yourself."
			;;
		esac
		;;
	aws)
		local svc="${NF[0]:-}" op="${NF[1]:-}"
		case "$svc $op" in
		"ec2 delete-volume")
			flag_value --volume-id
			if [ -z "$FV" ] || cmdline_has_var "$FV"; then
				refuse R-CLOUD "\`aws ec2 delete-volume\` without a literal --volume-id, so the volume cannot be snapshotted first."
			fi
			local vol="$FV"
			aws_globals
			backup B-CLOUD aws "aws ec2 delete-volume --volume-id $vol" bk_aws_volume "$vol"
			;;
		"rds delete-db-instance" | "rds delete-db-cluster")
			case " ${TOK[*]} " in *" --skip-final-snapshot"*)
				refuse R-CLOUD "\`aws rds $op --skip-final-snapshot\` deletes the database with no final snapshot." \
					"Drop --skip-final-snapshot and pass --final-db-snapshot-identifier <name>: RDS then takes the backup itself, and the delete is allowed."
				;;
			esac
			;;
		"secretsmanager delete-secret")
			case " ${TOK[*]} " in *" --force-delete-without-recovery"*)
				refuse R-CLOUD "\`aws secretsmanager delete-secret --force-delete-without-recovery\` deletes the secret with no recovery window." \
					"Drop the flag (optionally --recovery-window-in-days 7..30): the secret is then restorable with \`aws secretsmanager restore-secret\`, and the delete is allowed."
				;;
			esac
			;;
		esac
		;;
	kubectl)
		[ "${NF[0]:-}" = delete ] || return 0
		kube_context
		kube_disposable "$KCTX" && return 0
		kube_globals
		backup B-CLOUD kubernetes "kubectl delete in ${KCTX:-<unknown context>}" bk_kube_objects
		;;
	helm)
		case "${NF[0]:-}" in uninstall | delete | del | un) ;; *) return 0 ;; esac
		kube_context
		kube_disposable "$KCTX" && return 0
		[ -n "${NF[1]:-}" ] && ! cmdline_has_var "${NF[1]}" ||
			refuse R-CLOUD "\`helm ${NF[0]}\` without a literal release name, so the release cannot be exported first."
		kube_globals
		backup B-CLOUD kubernetes "helm ${NF[0]} ${NF[1]} in ${KCTX:-<unknown context>}" bk_helm_release "${NF[1]}"
		;;
	esac
	return 0
}

# bk_hcloud_server <context> <server> — a snapshot image of the server, taken before it goes.
bk_hcloud_server() {
	bk_exec "$BK/image.txt" hcloud --context "$1" server create-image --type snapshot \
		--description "guard-destroy backup $BK_TS" "$2" || return 1
	BK_SAVED="hcloud snapshot image of server $2 in $1 (image.txt)"
	BK_RESTORE="hcloud --context $1 server create --image <image id from image.txt> …"
}

# bk_aws_volume <volume-id> — an EBS snapshot. The snapshot is point-in-time from this call, so the
# delete may follow while it completes.
bk_aws_volume() {
	bk_exec "$BK/snapshot.json" aws "${AWSG[@]}" ec2 create-snapshot --volume-id "$1" \
		--description "guard-destroy backup $BK_TS" --output json || return 1
	BK_SAVED="EBS snapshot of $1 (snapshot.json)"
	BK_RESTORE="aws ec2 create-volume --snapshot-id <SnapshotId from snapshot.json> --availability-zone <az>"
}

# bk_kube_objects — the objects a `kubectl delete` names, as YAML: the same arguments with `delete`
# turned into `get -o yaml` and the delete-only flags dropped. This saves the manifests, not the
# data on a PersistentVolume.
bk_kube_objects() {
	local a args=() verb=0 skip=0
	for a in "${TOK[@]:1}"; do
		if [ "$skip" = 1 ]; then
			skip=0
			continue
		fi
		case "$a" in
		delete) if [ "$verb" = 0 ]; then
			verb=1
			args+=(get)
			continue
		fi ;;
		--grace-period | --timeout | --cascade | --wait) skip=1 && continue ;;
		--grace-period=* | --timeout=* | --cascade=* | --wait=* | --force | --now | -i | --interactive | --ignore-not-found* | --dry-run*) continue ;;
		esac
		args+=("$a")
	done
	bk_exec "$BK/objects.yaml" kubectl "${args[@]}" -o yaml || return 1
	BK_SAVED="the objects as YAML (objects.yaml) — manifests only, not volume data"
	BK_RESTORE="kubectl apply -f $BK/objects.yaml"
}

# bk_helm_release <release> — everything helm knows about the release (manifest, values, hooks).
bk_helm_release() {
	bk_exec "$BK/release.txt" helm get all "$1" "${KUBEG[@]}" || return 1
	BK_SAVED="helm get all $1 (release.txt)"
	BK_RESTORE="re-install from the chart with the values in release.txt"
}

# ── B-GH / B-GHAPI / R-GH / R-GHAPI ───────────────────────────────────────────────────────────
# The paths whose writes are backed up with a GET first: rules and protection, releases,
# packages, environments, hooks, secrets, tag protection, every git ref, and the repo/org itself.
GH_API_PROTECTED_RE='(^|/)(rulesets|protection|releases|packages|environments|hooks|actions/secrets|dependabot/secrets|codespaces/secrets|tags/protection)(/|$)'
GH_API_REFS_ANY_RE='(^|/)git/refs(/|$)'
GH_API_ROOT_RE='^(repos/[^/]+/[^/]+|orgs/[^/]+)/?$'
GH_API_POST_RE='(/transfer|/branches/[^/]+/rename)$'
GH_GRAPHQL_RE='(deleteRef|updateRefs?|deleteBranchProtectionRule|updateBranchProtectionRule|deleteRepositoryRuleset|updateRepositoryRuleset|archiveRepository|updateRepository|transferRepository|deleteEnvironment|deleteRelease|deletePackageVersion|deleteIssue|deleteDiscussion)[[:space:]]*(\(|$)'

# gh_first_arg <from-index> — sets GA: the first word of TOK at or after the index that is not a
# flag (or a known flag's value).
gh_first_arg() {
	local i n=${#TOK[@]} a
	GA=""
	for ((i = $1; i < n; i++)); do
		a="${TOK[$i]}"
		case "$a" in
		-R | --repo | -p | --pattern | -O | --output | -D | --dir | -e | --env | -o | --org | -a | --app | -c | --comment | -t | --title | -b | --body) i=$((i + 1)) ;;
		-*) ;;
		*)
			GA="$a"
			return 0
			;;
		esac
	done
	return 0
}

# gh_repo_flag — sets GHR: `-R <repo>` when the command named one with gh's global -R/--repo, so
# the hook's own gh calls reach the same repository (bk_exec runs them from the command's directory
# otherwise, where gh resolves the repository the same way the command would).
gh_repo_flag() {
	GHR=()
	[ -n "$CMDLINE_GH_REPO" ] && GHR=(-R "$CMDLINE_GH_REPO")
	return 0
}

rule_gh() {
	local sub="${TOK[1]:-}" verb="${TOK[2]:-}"
	gh_repo_flag
	case "$sub" in
	repo)
		gh_first_arg 3
		local r="${GA:-$CMDLINE_GH_REPO}"
		case "$verb" in
		delete | archive)
			backup B-GH gh-repo "gh repo $verb ${r:-<this repository>}" bk_gh_repo "$r" full
			;;
		rename)
			backup B-GH gh-repo "gh repo rename" bk_gh_repo "$CMDLINE_GH_REPO" meta
			;;
		edit) case " ${TOK[*]} " in *" --visibility"*)
			backup B-GH gh-repo "gh repo edit --visibility" bk_gh_repo "$r" meta
			;;
		esac ;;
		esac
		;;
	release)
		case "$verb" in delete | delete-asset)
			gh_first_arg 3
			[ -n "$GA" ] && ! cmdline_has_var "$GA" ||
				refuse R-GH "\`gh release $verb\` without a literal tag, so the release cannot be downloaded first."
			backup B-GH gh-release "gh release $verb $GA" bk_gh_release "$verb" "$GA"
			;;
		esac
		;;
	secret)
		case "$verb" in delete | remove)
			gh_first_arg 3
			secret_held "$GA" ||
				refuse R-GH "\`gh secret $verb ${GA:-<name>}\` deletes a secret whose value no credential profile holds, so it could never be put back." \
					"Store the value first (the maintainer runs \`! pnpm creds --set <profile>\` for a keychain profile in scripts/creds/profiles.json or ~/.alethia/creds-profiles.json that lists ${GA:-the name}); the delete is then allowed."
			;;
		esac
		;;
	issue)
		if [ "$verb" = delete ]; then
			gh_first_arg 3
			[ -n "$GA" ] && ! cmdline_has_var "$GA" ||
				refuse R-GH "\`gh issue delete\` without a literal issue number, so the issue cannot be exported first."
			backup B-GH gh-issue "gh issue delete $GA" bk_gh_issue "$GA"
		fi
		;;
	api) rule_gh_api ;;
	esac
	return 0
}

# secret_held <NAME> — is the value of a GitHub secret named NAME recoverable from a credential
# profile? True when a KEYCHAIN profile (repo scripts/creds/profiles.json or the machine-local
# ~/.alethia/creds-profiles.json) lists NAME among its vars AND the Keychain holds it (checked
# without -w, so the value is never read), or when an aws-secret profile lists NAME explicitly in
# its keys. An aws-secret profile with keys "*" proves nothing about one name, so it does not count.
secret_held() {
	local name="$1" f p
	[ -n "$name" ] && ! cmdline_has_var "$name" || return 1
	command -v jq >/dev/null 2>&1 || return 1
	for f in "$HOOK_DIR/../../scripts/creds/profiles.json" "$HOME/.alethia/creds-profiles.json"; do
		[ -f "$f" ] || continue
		jq -e --arg n "$name" '.profiles // {} | to_entries[] | select(.value.source == "aws-secret" and (.value.keys | type) == "array" and (.value.keys | index($n)))' "$f" >/dev/null 2>&1 && return 0
		while IFS= read -r p; do
			[ -n "$p" ] || continue
			security find-generic-password -s alethia-creds -a "$p/$name" >/dev/null 2>&1 && return 0
		done < <(jq -r --arg n "$name" '.profiles // {} | to_entries[] | select(.value.source == "keychain" and ((.value.vars // []) | index($n))) | .key' "$f" 2>/dev/null)
	done
	return 1
}

# bk_gh_repo <owner/repo|""> <full|meta> — the repository's metadata; for `full`, also a
# `git clone --mirror` (every branch, tag and ref) and a JSON export of every issue, PR and release.
# The export is a record, not something GitHub can re-import.
bk_gh_repo() {
	local r="$1" mode="$2"
	if [ -z "$r" ]; then
		bk_exec "$BK/.name" gh repo view --json nameWithOwner -q .nameWithOwner || return 1
		r="$(cat "$BK/.name")"
		rm -f "$BK/.name"
		[ -n "$r" ] || {
			BK_ERR="could not tell which repository this is"
			return 1
		}
	fi
	bk_exec "$BK/repo.json" gh repo view "$r" --json nameWithOwner,description,visibility,isArchived,defaultBranchRef,homepageUrl,repositoryTopics,url || return 1
	if [ "$mode" = meta ]; then
		BK_SAVED="the settings of $r before the change (repo.json)"
		BK_RESTORE="gh repo edit $r / gh repo rename, back to the values in repo.json"
		return 0
	fi
	bk_exec /dev/null gh repo clone "$r" "$BK/mirror.git" -- --mirror -q || return 1
	bk_exec "$BK/issues.json" gh issue list -R "$r" --state all --limit 100000 --json number,title,body,state,author,labels,assignees,createdAt,closedAt,comments,url || return 1
	bk_exec "$BK/prs.json" gh pr list -R "$r" --state all --limit 100000 --json number,title,body,state,author,labels,headRefName,baseRefName,createdAt,closedAt,mergedAt,comments,url || return 1
	bk_exec "$BK/releases.json" gh release list -R "$r" --limit 1000 --json tagName,name,isDraft,isPrerelease,createdAt,publishedAt || return 1
	BK_SAVED="$r: git mirror (mirror.git), issues.json, prs.json, releases.json, repo.json"
	BK_RESTORE="gh repo create $r --private && git -C $BK/mirror.git push --mirror https://github.com/$r.git (or gh repo unarchive $r)"
}

# bk_gh_release <delete|delete-asset> <tag> [asset] — the release's metadata and body, and its
# assets (only the named one for delete-asset); for --cleanup-tag, also the tag's ref.
bk_gh_release() {
	local verb="$1" tag="$2" asset="" n
	[ "$verb" = delete-asset ] && {
		gh_first_arg 4
		asset="$GA"
	}
	bk_exec "$BK/release.json" gh release view "$tag" "${GHR[@]}" --json tagName,name,body,isDraft,isPrerelease,targetCommitish,createdAt,publishedAt,url,assets || return 1
	n="$(jq '.assets | length' "$BK/release.json" 2>/dev/null)"
	if [ -n "$asset" ]; then
		bk_exec /dev/null gh release download "$tag" "${GHR[@]}" -D "$BK/assets" -p "$asset" || return 1
	elif [ "${n:-0}" != 0 ]; then
		bk_exec /dev/null gh release download "$tag" "${GHR[@]}" -D "$BK/assets" || return 1
	fi
	case " ${TOK[*]} " in *" --cleanup-tag"*)
		bk_exec "$BK/tag-ref.json" env ${CMDLINE_GH_REPO:+GH_REPO="$CMDLINE_GH_REPO"} gh api "repos/{owner}/{repo}/git/ref/tags/$tag" || return 1
		;;
	esac
	BK_SAVED="release $tag: release.json (body and metadata)${n:+, $n asset(s) in assets/}"
	BK_RESTORE="gh release create $tag --notes \"\$(jq -r .body $BK/release.json)\" $BK/assets/*"
}

# bk_gh_issue <number> — the issue, its body and every comment, as JSON.
bk_gh_issue() {
	bk_exec "$BK/issue.json" gh issue view "$1" "${GHR[@]}" --json number,title,body,state,author,labels,assignees,comments,createdAt,closedAt,url || return 1
	BK_SAVED="issue $1 with its comments (issue.json)"
	BK_RESTORE="a deleted issue cannot be undeleted; recreate it from issue.json"
}

# bk_gh_api_get <path> — the resource as it is now, from a GET of the same path. A 404 means there
# is nothing yet (a PUT creating protection, say): nothing to save.
bk_gh_api_get() {
	if ! bk_exec "$BK/before.json" gh api "$1"; then
		case "$BK_ERR" in *"HTTP 404"* | *"Not Found"*)
			BK_EMPTY=1
			BK_SAVED="$1 does not exist yet"
			BK_ERR=""
			return 0
			;;
		esac
		return 1
	fi
	BK_SAVED="GET $1 before the write (before.json)"
	BK_RESTORE="gh api -X PUT|PATCH|POST to the same path with the fields in before.json"
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
		# A mutation's target is an opaque node id: there is no GET to back it up with.
		if [ "$input" = 1 ]; then
			# @mut graphql-file
			refuse R-GHAPI "\`gh api graphql\` reads its query from a file or stdin, which the guard cannot read." \
				"Pass the query inline with -f query='…' so the mutation is visible."
		fi
		[[ "$CMD" =~ $GH_GRAPHQL_RE ]] && refuse R-GHAPI "a graphql \`${BASH_REMATCH[1]}\` mutation deletes or rewrites repository state, and a node id cannot be backed up first." \
			"Use the REST endpoint or the gh subcommand for the same change (gh api -X DELETE repos/…, gh release delete, git push --delete): the guard backs those up and lets them through."
		return 0
	fi
	xp "$path"
	path="$X"
	local protected=0
	if [[ "$path" =~ $GH_API_PROTECTED_RE ]] || [[ "$path" =~ $GH_API_ROOT_RE ]] || [[ "$path" =~ $GH_API_REFS_ANY_RE ]]; then
		protected=1
	fi
	case "$method" in
	DELETE | PUT | PATCH)
		[ "$protected" = 1 ] || return 0
		if cmdline_has_var "$path"; then
			refuse R-GHAPI "\`gh api -X $method $path\` writes protected repository state at a path the guard cannot read, so it cannot be backed up first." \
				"Spell the path literally."
		fi
		if [ "$method" = DELETE ] && [[ "$path" =~ (^|/)(actions|dependabot|codespaces)/secrets/([^/]+)$ ]]; then
			local sname="${BASH_REMATCH[3]}"
			secret_held "$sname" ||
				refuse R-GHAPI "\`gh api -X DELETE $path\` deletes a secret whose value no credential profile holds, so it could never be put back." \
					"Store the value first (\`! pnpm creds --set <profile>\`, a keychain profile listing $sname); the delete is then allowed."
			return 0
		fi
		if [ "$method" = DELETE ] && [[ "$path" =~ $GH_API_ROOT_RE ]] && [[ "$path" == repos/* ]]; then
			local rr="${path#repos/}"
			backup B-GHAPI gh-repo "gh api -X DELETE $path" bk_gh_repo "${rr%/}" full
			return 0
		fi
		backup B-GHAPI gh-api "gh api -X $method $path" bk_gh_api_get "$path"
		;;
	POST)
		if [[ "$path" =~ $GH_API_POST_RE ]]; then
			backup B-GHAPI gh-api "gh api -X POST $path" bk_gh_api_get "${path%/*}"
		fi
		;;
	GET | HEAD) ;;
	*)
		# A method the guard cannot read (a variable) on a protected path: it cannot know what to
		# back up, so it fails closed.
		if [ "$protected" = 1 ]; then
			refuse R-GHAPI "\`gh api\` with an unreadable method ($method) on the protected path $path." \
				"Spell -X literally; the guard then backs the resource up and lets the call through."
		fi
		;;
	esac
	return 0
}

# creds_unwrap — `pnpm creds <profile> -- <command>` (or `python3 scripts/creds.py …`) runs
# <command> with the profile's secrets in its environment. Judge <command> itself, and remember the
# profile in CREDS_PROFILE so a backup that needs the same access (a state pull, a pg_dump) runs
# under the same broker. The prefix assignments of the outer command are kept.
CREDS_PROFILE=""
CREDS_PY="${ALETHIA_CREDS_PY:-$HOOK_DIR/../../scripts/creds.py}"
creds_unwrap() {
	local outer_env="$SEG_ENV" profile="" i n=${#TOK[@]}
	CREDS_PROFILE=""
	case "${TOK[0]##*/} ${TOK[1]:-}" in
	"pnpm creds") i=2 ;;
	python3\ *creds.py | python\ *creds.py) i=2 ;;
	*) return 0 ;;
	esac
	for (( ; i < n; i++)); do
		case "${TOK[$i]}" in
		--) break ;;
		-*) return 0 ;;
		*) [ -n "$profile" ] || profile="${TOK[$i]}" ;;
		esac
	done
	[ "$i" -lt "$n" ] && [ -n "$profile" ] || return 0
	case "$SEG" in *" -- "*) ;; *) return 0 ;; esac
	cmdline_normalise "${SEG#* -- }"
	SEG_ENV="$outer_env$SEG_ENV"
	CREDS_PROFILE="$profile"
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
		creds_unwrap
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
# worktree and a local bare "origin" in a tmpdir, a fake $HOME (so every backup lands in the tmpdir),
# a fake credential broker, and PATH stubs for gh, security, tofu, terraform, pg_dump, docker, hcloud,
# aws, kubectl and helm, so it is hermetic: nothing reaches GitHub, a cloud, a database or the
# Keychain. Counters are incremented in THIS shell (never a pipeline or `$( )`), and the exit code
# is the test.
#
# `--mutation-test` copies the hook, disables each rule's call sites in turn (`refuse R-X` /
# `backup B-X` / `snap S-X` / `pin S-X` → `true`), and requires the self-test to FAIL for every
# one. The rule list is DERIVED from the file, so a new rule without a failing case fails the
# mutation test. A disabled backup is caught because the self-test checks what each backup saved.
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
	# The remote the push backups fetch from: a local bare repository holding the three protected
	# branches, a feature branch and a release tag. Nothing in this test ever pushes to it — the hook
	# only reads it.
	G init --bare "$tmp/origin.git"
	G -C "$repo" remote add origin "$tmp/origin.git"
	G -C "$repo" branch main
	G -C "$repo" branch staging
	G -C "$repo" tag v1.0.0
	G -C "$repo" push origin dev main staging feat/a v1.0.0

	# Stubs for every program a backup runs, so nothing here reaches GitHub, AWS, Hetzner, a cluster,
	# a database or the Keychain. Each logs its argv to $STUBLOG; a name containing "missing",
	# "ghost", "broken", "unreachable", "fails" or "nobackend" makes it fail the way the real one would.
	cat >"$stub/kubectl" <<'STUB'
#!/usr/bin/env bash
echo "kubectl $*" >>"$STUBLOG"
[ "$1 $2" = "config current-context" ] && { echo "${STUB_KUBE_CONTEXT:-prod-cluster}"; exit 0; }
case " $* " in *" get "*) case "$*" in *ghost*) echo 'Error from server (NotFound)' >&2; exit 1 ;; esac; echo 'kind: List'; exit 0 ;; esac
exit 1
STUB
	cat >"$stub/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$STUBLOG"
args=" $* "
case "$1 $2" in
"repo view")
	case "$args" in *" -q "*) echo o/r ;; *) echo '{"nameWithOwner":"o/r","visibility":"PUBLIC"}' ;; esac ;;
"repo clone") mkdir -p "$4" && echo 'ref: refs/heads/dev' >"$4/HEAD" ;;
"issue list" | "pr list" | "release list") echo '[]' ;;
"issue view") echo "{\"number\":$3,\"comments\":[]}" ;;
"release view")
	case "$3" in *missing*) echo 'release not found' >&2; exit 1 ;; esac
	echo "{\"tagName\":\"$3\",\"body\":\"notes\",\"assets\":[{\"name\":\"a.tgz\"}]}" ;;
"release download")
	d=""; p="a.tgz"
	while [ $# -gt 0 ]; do case "$1" in -D) d="$2"; shift ;; -p) p="$2"; shift ;; esac; shift; done
	mkdir -p "$d" && echo asset >"$d/$p" ;;
api*)
	case "$2" in *missing*) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;; *fails*) echo 'gh: Server Error (HTTP 500)' >&2; exit 1 ;; esac
	echo "{\"path\":\"$2\",\"repo\":\"${GH_REPO:-}\"}" ;;
*) exit 0 ;;
esac
STUB
	cat >"$stub/security" <<'STUB'
#!/usr/bin/env bash
echo "security $*" >>"$STUBLOG"
case "$*" in *" -w"* | *" -g"*) exit 9 ;; esac
acct=""; while [ $# -gt 0 ]; do [ "$1" = -a ] && acct="$2"; shift; done
case " ${STUB_KEYCHAIN:-} " in *" $acct "*) exit 0 ;; esac
exit 44
STUB
	cat >"$stub/tofu" <<'STUB'
#!/usr/bin/env bash
echo "tofu $* ws=${TF_WORKSPACE:-}" >>"$STUBLOG"
case "$*" in *"state pull"*)
	case "$*" in *nobackend*) echo 'Error: Backend initialization required' >&2; exit 1 ;; *empty*) exit 0 ;; esac
	printf '{"version":4,"serial":7,"workspace":"%s"}\n' "${TF_WORKSPACE:-default}" ;;
esac
STUB
	cp "$stub/tofu" "$stub/terraform"
	cat >"$stub/pg_dump" <<'STUB'
#!/usr/bin/env bash
echo "pg_dump $*" >>"$STUBLOG"
f=""; for a in "$@"; do case "$a" in --file=*) f="${a#--file=}" ;; esac; done
case "$*" in *unreachable*) echo 'pg_dump: error: connection to server failed' >&2; exit 1 ;; esac
echo PGDMP >"$f"
STUB
	cat >"$stub/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUBLOG"
case "$1 $2" in
"volume ls") printf 'alethia_pgdata\nscratch\n' ;;
inspect*) echo anonvol123 ;;
run*)
	case "$*" in *broken*) echo 'no such volume' >&2; exit 1 ;; esac
	h=""; n=""
	for a in "$@"; do case "$a" in *:/b) h="${a%:/b}" ;; /b/*.tgz) n="${a#/b/}" ;; esac; done
	echo tar >"$h/$n" ;;
esac
STUB
	cat >"$stub/hcloud" <<'STUB'
#!/usr/bin/env bash
echo "hcloud $*" >>"$STUBLOG"
case "$*" in *create-image*) case "$*" in *ghost*) echo 'hcloud: server not found' >&2; exit 1 ;; esac; echo 'Image 42 created' ;; esac
STUB
	cat >"$stub/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >>"$STUBLOG"
case "$*" in *create-snapshot*) echo '{"SnapshotId":"snap-1"}' ;; esac
STUB
	cat >"$stub/helm" <<'STUB'
#!/usr/bin/env bash
echo "helm $*" >>"$STUBLOG"
[ "$1 $2" = "get all" ] && echo 'MANIFEST:'
STUB
	# the credential broker: a profile name, `--`, and the command, run with a URL in its env
	cat >"$stub/creds.py" <<'STUB'
import os, sys
a = sys.argv[1:]
with open(os.environ["STUBLOG"], "a") as f:
    f.write("creds " + " ".join(a) + "\n")
i = a.index("--")
os.environ["ALETHIA_DATABASE_URL"] = "postgres://u:secretpw@prod.example.com/a"
os.execvp(a[i + 1], a[i + 1:])
STUB
	chmod +x "$stub"/*
	mkdir -p "$home/.alethia"
	cat >"$home/.alethia/creds-profiles.json" <<'JSON'
{"profiles": {
  "cf": {"source": "keychain", "vars": ["CLOUDFLARE_API_TOKEN"]},
  "vault": {"source": "aws-secret", "secret_id": "x", "keys": ["STRIPE_API_KEY"]},
  "everything": {"source": "aws-secret", "secret_id": "y", "keys": "*"}
}}
JSON

	run() { # <cwd> <command> [env…] — sets RC
		local cwd="$1" cmd="$2" payload
		shift 2
		payload="$(jq -n --arg c "$cmd" --arg d "$cwd" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')"
		printf '%s' "$payload" | env HOME="$home" CLAUDE_PROJECT_DIR="$repo" PATH="$stub:$PATH" \
			STUBLOG="$tmp/calls.log" ALETHIA_CREDS_PY="$stub/creds.py" STUB_KEYCHAIN= \
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
	# bk <kind> <want-new-backups> <cwd> <command> [env…] — the command is ALLOWED and leaves exactly
	# N new backup directories under ~/.alethia/backups/<kind>/. BK_NEW is the newest, for the
	# content checks; the stub log of THIS run is in $tmp/calls.log.
	bk() {
		local kind="$1" want="$2" cwd="$3" cmd="$4" got d="$home/.alethia/backups/$1"
		shift 4
		ls -1 "$d" 2>/dev/null | sort >"$tmp/bk.before"
		: >"$tmp/calls.log"
		run "$cwd" "$cmd" "$@"
		ls -1 "$d" 2>/dev/null | sort >"$tmp/bk.after"
		got="$(comm -13 "$tmp/bk.before" "$tmp/bk.after" | wc -l | tr -d ' ')"
		BK_NEW="$d/$(comm -13 "$tmp/bk.before" "$tmp/bk.after" | tail -1)"
		if [ "$RC" = 0 ] && [ "$got" = "$want" ]; then pass=$((pass + 1)); else
			fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
			echo "  ✗ backup $kind: rc=$RC new backups=$got want $want : $cmd ($(head -c 300 "$tmp/stderr"))"
		fi
	}
	# has <label> <file-under-BK_NEW> [grep-pattern] — the newest backup holds that file (with that text).
	has() {
		local label="$1" f="$BK_NEW/$2"
		if [ -s "$f" ] && { [ -z "${3:-}" ] || grep -q -- "$3" "$f"; }; then pass=$((pass + 1)); else
			fail=$((fail + 1)); [ -z "${SELFTEST_FAILFAST:-}" ] || exit 1
			echo "  ✗ $label: $f${3:+ with '$3'}"
		fi
	}
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

	# ── B-PUSH: the remote refs a push overwrites or deletes are copied first ──
	local mainsha
	mainsha="$(git -C "$tmp/origin.git" rev-parse main)"
	bk remote-refs 1 "$wt" 'git push origin main'
	has 'a push to main records the remote main' refs.txt 'refs/heads/main:refs/safety/remote/'
	check 'the remote main is now a local safety ref' test "$(git -C "$repo" rev-parse "refs/safety/remote/${BK_NEW##*/}/heads/main" 2>/dev/null)" = "$mainsha"
	has 'the backup carries a MANIFEST' MANIFEST 'git push origin main'
	bk remote-refs 1 "$wt" 'git push origin staging'
	has 'staging' refs.txt 'heads/staging'
	bk remote-refs 1 "$wt" 'git push -f origin main'
	bk remote-refs 1 "$wt" 'git push origin +main'
	bk remote-refs 1 "$wt" 'git push origin HEAD:main'
	has 'HEAD:main is main' refs.txt 'heads/main'
	bk remote-refs 1 "$wt" 'git push origin feat/a:refs/heads/dev'
	has 'a refspec onto dev' refs.txt 'heads/dev'
	bk remote-refs 1 "$wt" 'git push origin :main'
	bk remote-refs 1 "$wt" 'git push --delete origin staging'
	bk remote-refs 1 "$wt" 'git push --mirror origin'
	has '--mirror records every branch' refs.txt 'heads/feat/a'
	has '--mirror records every tag' refs.txt 'tags/v1.0.0'
	bk remote-refs 1 "$wt" 'git push --all --force origin'
	has '--all --force records every branch' refs.txt 'heads/staging'
	bk remote-refs 1 "$wt" 'git push origin :refs/tags/v1.0.0'
	has 'a tag delete records the tag' refs.txt 'tags/v1.0.0'
	bk remote-refs 1 "$wt" "git -C $repo push"
	has 'a bare push from dev records dev' refs.txt 'heads/dev'
	bk remote-refs 1 "$repo" 'git push'
	bk remote-refs 1 "$wt" 'git push origin "refs/heads/*:refs/heads/*"'
	has 'a wildcard records what it matches' refs.txt 'heads/main'
	bk remote-refs 1 "$wt" 'sh -c "git push origin main"'
	t block "$wt" 'git -C "$W" push'
	t block "$wt" 'git -C "$W" push origin main'
	bk remote-refs 0 "$wt" 'git push -u origin feat/a'
	bk remote-refs 1 "$wt" 'git push --force-with-lease origin feat/a'
	has 'a force-push to a feature branch records it' refs.txt 'heads/feat/a'
	bk remote-refs 0 "$wt" 'git push'
	bk remote-refs 0 "$wt" 'git push origin HEAD'
	bk remote-refs 0 "$wt" 'git push origin v1.2.3'
	# a variable assigned earlier in the SAME command is resolved, not treated as unknown
	bk remote-refs 0 "$tmp" "W=$wt; git -C \$W push"
	bk remote-refs 1 "$tmp" "W=$repo; git -C \$W push"
	bk remote-refs 1 "$tmp" "W=$repo && cd \$W && git push"
	# a remote that cannot be read: the backup fails, so the push is refused
	t block "$wt" 'git push no-such-remote main'

	# ── B-PUSH: tag deletes in every spelling, prune, and the refs/safety boundary ──
	bk remote-refs 1 "$wt" 'git push --delete origin v1.0.0'
	has 'a short-name delete records the tag' refs.txt 'tags/v1.0.0'
	bk remote-refs 1 "$wt" 'git push origin :v1.0.0'
	bk remote-refs 0 "$wt" 'git push origin --delete never-heard-of-it'
	bk remote-refs 1 "$wt" 'git push origin --tags --prune'
	has '--tags --prune records the tags' refs.txt 'tags/v1.0.0'
	bk remote-refs 1 "$wt" 'git push --prune origin "refs/tags/*:refs/tags/*"'
	bk remote-refs 1 "$wt" 'git push --prune --all origin'
	has '--prune --all records the branches' refs.txt 'heads/main'
	bk remote-refs 1 "$wt" 'git push --prune-tags origin'
	has '--prune-tags records the tags' refs.txt 'tags/v1.0.0'
	bk remote-refs 1 "$wt" 'git push --tags --force origin'
	has '--tags --force records the tags' refs.txt 'tags/v1.0.0'
	bk remote-refs 1 "$wt" 'git push origin --delete feat/a'
	t block "$wt" 'git push origin "refs/safety/*:refs/safety/*"'
	t block "$wt" 'git push origin feat/a:refs/safety/x'
	t block "$wt" 'git push origin refs/safety/wt-a/20261106T000000Z:refs/heads/feat/leak'
	bk remote-refs 0 "$wt" 'git push origin :refs/heads/feat/old'
	bk remote-refs 0 "$wt" 'git push --tags origin'
	bk remote-refs 1 "$wt" 'git push --prune origin "refs/heads/feat/*:refs/heads/feat/*"'
	# putting a backed-up ref BACK is a push like any other (refs/safety/remote/ holds no snapshot)
	local rref
	rref="$(git -C "$repo" for-each-ref --format='%(refname)' 'refs/safety/remote/*/heads/main' | head -1)"
	bk remote-refs 1 "$wt" "git push origin $rref:refs/heads/main"

	# ── B-GH / B-GHAPI ──
	bk gh-repo 1 "$wt" 'gh repo delete alethialabs-io/app --yes'
	has 'repo delete mirrors the repository' mirror.git/HEAD
	has 'repo delete exports the issues' issues.json
	has 'repo delete exports the PRs' prs.json
	check 'the mirror is of the named repository' grep -q 'gh repo clone alethialabs-io/app .* --mirror' "$tmp/calls.log"
	bk gh-repo 1 "$wt" 'gh repo archive'
	check 'an unnamed repository is resolved first' grep -q 'gh repo clone o/r' "$tmp/calls.log"
	bk gh-repo 1 "$wt" 'gh repo rename new-name'
	has 'a rename records the settings' repo.json nameWithOwner
	check 'a rename does not mirror' test ! -e "$BK_NEW/mirror.git"
	bk gh-repo 1 "$wt" 'gh repo edit --visibility private'
	has 'a visibility change records the settings' repo.json PUBLIC
	bk gh-release 1 "$wt" 'gh release delete v1.0.0 --yes'
	has 'release delete saves the body' release.json notes
	has 'release delete downloads the assets' assets/a.tgz
	bk gh-release 1 "$wt" 'gh release delete-asset v1 file.tgz'
	has 'delete-asset downloads that asset' assets/file.tgz
	bk gh-release 1 "$wt" 'gh release delete v1 --cleanup-tag --yes'
	has '--cleanup-tag records the tag ref' tag-ref.json 'git/ref/tags/v1'
	t block "$wt" 'gh release delete v-missing --yes'
	t block "$wt" 'gh release delete $T --yes'
	t block "$wt" 'gh secret delete HCLOUD_TOKEN'
	t block "$wt" 'gh secret delete CLOUDFLARE_API_TOKEN'
	t allow "$wt" 'gh secret delete CLOUDFLARE_API_TOKEN' STUB_KEYCHAIN=cf/CLOUDFLARE_API_TOKEN
	t allow "$wt" 'gh secret remove STRIPE_API_KEY'
	t block "$wt" 'gh secret delete ANYTHING_IN_THE_VAULT'
	bk gh-issue 1 "$wt" 'gh issue delete 12 --yes'
	has 'issue delete exports the issue' issue.json '"number":12'
	t block "$wt" 'gh issue delete $N --yes'
	bk gh-api 1 "$wt" 'gh api -X DELETE repos/o/r/rulesets/1'
	has 'a ruleset delete GETs it first' before.json 'repos/o/r/rulesets/1'
	bk gh-api 1 "$wt" 'gh api --method PUT repos/o/r/branches/main/protection --input p.json'
	bk gh-api 1 "$wt" 'gh api -X PATCH repos/o/r -f name=renamed'
	has 'a repo PATCH GETs the repo' before.json '"path":"repos/o/r"'
	bk gh-api 1 "$wt" 'gh api -XDELETE /repos/o/r/git/refs/heads/main'
	has 'a ref delete records the ref' before.json 'git/refs/heads/main'
	bk gh-api 1 "$wt" 'gh api -X DELETE repos/o/r/releases/42'
	bk gh-api 1 "$wt" 'gh api -X DELETE /orgs/o/packages/container/x'
	bk gh-api 1 "$wt" 'gh api -X DELETE repos/o/r/environments/production'
	bk gh-api 1 "$wt" 'gh api -X DELETE repos/o/r/hooks/7'
	t block "$wt" 'gh api -X DELETE repos/o/r/actions/secrets/FOO'
	t allow "$wt" 'gh api -X DELETE repos/o/r/actions/secrets/STRIPE_API_KEY'
	bk gh-repo 1 "$wt" 'gh api -X DELETE repos/o/r'
	has 'a repo DELETE through the API mirrors it' mirror.git/HEAD
	bk gh-api 1 "$wt" 'gh api repos/o/r/transfer -f new_owner=x'
	has 'a transfer GETs the repo' before.json '"path":"repos/o/r"'
	bk gh-api 1 "$wt" 'gh api -X POST repos/o/r/branches/dev/rename -f new_name=x'
	has 'a branch rename GETs the branch' before.json 'branches/dev'
	bk gh-api 0 "$wt" 'gh api -X PUT repos/o/r/environments/missing-env'
	t block "$wt" 'gh api -X DELETE repos/o/r/rulesets/fails'
	t block "$wt" 'gh api -X $M repos/o/r/rulesets/1'
	t block "$wt" "gh api graphql -f query='mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }'"
	t block "$wt" 'gh api graphql --input q.json'
	bk gh-api 0 "$wt" 'gh api repos/o/r/rulesets'
	# gh's global flags before the subcommand
	bk gh-release 1 "$wt" 'gh -R o/r release delete v1 --yes'
	check 'the backup reads the -R repository' grep -q 'gh release view v1 -R o/r' "$tmp/calls.log"
	t block "$wt" 'gh --repo o/r secret delete FOO'
	bk gh-repo 1 "$wt" 'gh --repo=o/r repo delete --yes'
	check 'repo delete with --repo= mirrors that repository' grep -q 'gh repo clone o/r' "$tmp/calls.log"
	bk gh-issue 1 "$wt" 'gh -Ro/r issue delete 5 --yes'
	bk gh-api 1 "$wt" 'gh --hostname github.com -R o/r api -X DELETE repos/o/r/rulesets/1'
	bk gh-release 0 "$wt" 'gh -R o/r release list'
	t allow "$wt" 'gh --repo o/r pr view 12'
	# a full URL is the same path; a graphql body from a file cannot be read
	bk gh-repo 1 "$wt" 'gh api -X DELETE https://api.github.com/repos/o/r'
	bk gh-api 1 "$wt" 'gh api -X DELETE https://ghe.example.com/api/v3/repos/o/r/rulesets/2'
	has 'a GHES URL is read as its path' before.json 'repos/o/r/rulesets/2'
	t block "$wt" 'gh api graphql -F query=@mutation.graphql'
	t allow "$wt" 'gh api graphql -F owner=o -f query=query{viewer{login}}'
	bk gh-api 1 "$wt" 'gh api -X PATCH repos/o/r/git/refs/heads/deps/npm-minor -f sha=abc -F force=true'
	bk gh-api 1 "$wt" 'R=repos/o/r; gh api -X PATCH $R/git/refs/heads/deps/x -f sha=abc'
	has 'a path built from an earlier assignment is resolved' before.json 'repos/o/r/git/refs/heads/deps/x'
	bk gh-api 1 "$wt" 'gh api -X DELETE repos/o/r/git/refs/tags/v1.0.0'
	t block "$wt" 'gh api -X PATCH repos/o/r/git/refs/heads/$B -f sha=abc'
	bk gh-api 0 "$wt" 'gh api -X POST repos/o/r/issues/1/comments -f body=hi'
	t allow "$wt" "gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:\"x\"}) { thread { id } } }'"
	t allow "$wt" 'gh pr view 12'
	t allow "$wt" 'gh release list'
	t allow "$wt" 'gh secret list'

	# ── B-TFSTATE: local state is copied out before anything can delete it ──
	mkdir -p "$repo/infra/sandbox" "$repo/infra/cp" "$repo/infra/gcp-e2e" "$repo/infra/empty" "$repo/infra/nobackend"
	printf '{"serial":1}' >"$repo/infra/sandbox/terraform.tfstate"
	local sbs="files$repo/infra/sandbox/terraform.tfstate"
	bk tfstate 1 "$repo" 'git clean -fdx'
	has 'git clean -x copies the state out' "$sbs" serial
	bk tfstate 1 "$repo" 'git clean -fX'
	bk tfstate 1 "$repo" 'rm infra/sandbox/terraform.tfstate'
	has 'rm of a state file copies it' "$sbs" serial
	bk tfstate 0 "$repo" 'rm -f infra/sandbox/terraform.tfstate.backup'
	bk tfstate 1 "$repo" 'rm -rf infra'
	has 'rm -r of a directory holding state copies it' "$sbs"
	bk tfstate 1 "$repo" 'mv infra/sandbox/terraform.tfstate /tmp/x'
	bk tfstate 1 "$repo" 'cp /tmp/empty.json infra/sandbox/terraform.tfstate'
	bk tfstate 1 "$repo" 'echo "{}" > infra/sandbox/terraform.tfstate'
	has 'a redirection onto state copies it first' "$sbs" serial
	bk tfstate 1 "$repo" 'tofu -chdir=infra/sandbox state rm hcloud_server.sandbox'
	has 'state rm on a local backend copies the local file' "$sbs"
	check 'a local backend is not pulled' bash -c "! grep -q 'state pull' '$tmp/calls.log'"
	bk tfstate 1 "$repo/infra/cp" 'terraform state mv a b'
	has 'state mv on a remote backend pulls the state' state-pull.tfstate '"serial":7'
	bk tfstate 1 "$repo/infra/cp" 'tofu state push x.tfstate'
	bk tfstate 1 "$repo" 'tofu -chdir=infra/gcp-e2e init -migrate-state'
	check 'the pull runs against the -chdir module' grep -q "chdir=$repo/infra/gcp-e2e state pull" "$tmp/calls.log"
	bk tfstate 1 "$repo/infra/cp" 'tofu init -force-copy'
	bk tfstate 1 "$repo/infra/cp" 'tofu workspace delete old'
	has 'workspace delete pulls THAT workspace' state-pull.tfstate '"workspace":"old"'
	bk tfstate 0 "$repo" 'tofu -chdir=infra/empty state rm x'
	t block "$repo" 'tofu -chdir=infra/nobackend state rm x'
	t block "$repo" 'tofu -chdir=$D state rm x'
	bk tfstate 1 "$repo" 'pnpm creds tofu-sandbox -- tofu -chdir=infra/cp state rm x'
	check 'a brokered command is backed up through the same broker' grep -q '^creds tofu-sandbox -- ' "$tmp/calls.log"
	has 'the brokered pull reaches the file intact' state-pull.tfstate '"serial":7'
	bk tfstate 0 "$repo" "git clean -fdx -e '*.tfstate*'"
	bk tfstate 0 "$repo" 'cp infra/sandbox/terraform.tfstate /tmp/state-backup.json'
	bk tfstate 0 "$repo" 'tofu -chdir=infra/sandbox state list'
	bk tfstate 0 "$repo" 'tofu -chdir=infra/sandbox plan -out=tfplan'
	t allow "$repo" 'tofu init -backend=false'
	t allow "$repo" 'grep -rn tfstate infra/'
	t block "$wt" 'git -C "$W" clean -fdx'
	# bulk deleters (find / rsync) that can reach local state
	bk tfstate 1 "$repo" "find . -name '*.tfstate' -delete"
	has 'a find naming state copies it at any depth' "$sbs"
	bk tfstate 1 "$repo" 'find infra -type f -delete'
	bk tfstate 1 "$repo" 'find infra -exec rm {} +'
	bk tfstate 1 "$repo" 'rsync -a --delete /tmp/empty/ infra/'
	t block "$repo" 'find $D -name "*.tfstate" -delete'
	bk tfstate 0 "$repo" "find . -name '*.log' -delete"
	bk tfstate 0 "$repo" 'find /tmp/x -type f -delete'
	bk tfstate 0 "$repo" 'rsync -a --delete /tmp/a/ /tmp/b/'
	t allow "$repo" 'find infra -name "*.tf"'
	check 'every tfstate backup directory is private (700)' bash -c "[ \"\$(ls -ld '$home/.alethia/backups/tfstate' | cut -c1-10)\" = drwx------ ]"

	# ── B-DB: a non-local database is pg_dumped first ──
	t block "$wt" 'pnpm -F console db:reset'
	t block "$wt" 'pnpm -C apps/console run db:migrate'
	bk db 1 "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p4ss@prod.db.example.com:5432/a pnpm -F console db:reset'
	has 'a remote reset is dumped first' db.dump PGDMP
	check 'the MANIFEST never carries the password' bash -c "! grep -q p4ss '$BK_NEW/MANIFEST'"
	bk db 1 "$wt" 'export ALETHIA_DATABASE_URL=postgres://u:p@ep-x.neon.tech/a && pnpm -F console db:migrate'
	t block "$wt" 'ALETHIA_DATABASE_URL="$(aws secretsmanager get-secret-value --secret-id x)" pnpm -F console db:reset'
	bk db 1 "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@localhost/a?host=prod.example.com pnpm -F console db:reset'
	t block "$wt" 'cd apps/console && npx drizzle-kit push'
	t block "$wt" 'node --env-file=.env apps/console/scripts/reset.mjs'
	bk db 1 "$wt" 'pnpm -F console db:reencrypt' ALETHIA_DATABASE_URL=postgres://u:p@prod.example.com/a
	t block "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@unreachable.example.com/a pnpm -F console db:reset'
	bk db 1 "$wt" 'pnpm creds prod-env -- pnpm -F console db:migrate'
	has 'a brokered migrate is dumped through the broker' db.dump PGDMP
	check 'the brokered dump ran under that profile' grep -q '^creds prod-env -- ' "$tmp/calls.log"
	bk db 1 "$wt" 'pnpm creds prod-env -- pnpm -C apps/console run db:backfill-plan-metadata --apply'
	has 'a brokered backfill is dumped through the broker' db.dump PGDMP
	bk db 0 "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@localhost:5432/a pnpm -F console db:reset'
	bk db 0 "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@127.0.0.1:5432/a pnpm -C apps/console run db:migrate'
	bk db 0 "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@[::1]:5432/a pnpm -F console db:reset'
	bk db 0 "$wt" 'ALETHIA_DATABASE_URL=postgres://u:p@db:5432/a pnpm -F console db:migrate'
	bk db 0 "$wt" 'pnpm -F console db:migrate' ALETHIA_DATABASE_URL=postgres://u:p@localhost/a
	t allow "$wt" 'pnpm -F console db:generate'
	t allow "$wt" 'pnpm -F console test'
	t allow "$wt" 'git commit -m "guard: refuse db:reset against a remote host"'
	t allow "$wt" 'gh pr create --title "x" --body "covers pnpm -F console db:reset"'

	# ── B-DOCKER ──
	bk docker-volumes 1 "$wt" 'docker volume rm alethia_pgdata'
	has 'volume rm tars the volume' alethia_pgdata.tgz
	bk docker-volumes 1 "$wt" 'docker volume prune -f'
	has 'a prune saves the alethia volumes it would remove' alethia_pgdata.tgz
	check 'a prune does not save the others' test ! -e "$BK_NEW/scratch.tgz"
	bk docker-volumes 1 "$wt" 'docker system prune -a --volumes'
	bk docker-volumes 1 "$wt" 'docker rm -v alethia-postgres-1'
	has 'rm -v saves the container volumes' anonvol123.tgz
	t block "$wt" 'docker volume rm $V'
	t block "$wt" 'docker volume rm alethia_broken'
	bk docker-volumes 0 "$wt" 'docker volume rm scratch_vol'
	t allow "$wt" 'docker volume ls'
	t allow "$wt" 'docker ps'
	t allow "$wt" 'docker rm old-container'

	# ── B-CLOUD ──
	t block "$wt" 'hcloud server delete box'
	t block "$wt" 'hcloud --context tovr-prod server delete box'
	t block "$wt" 'hcloud --context alethia-console-prod volume delete v'
	t block "$wt" 'HCLOUD_TOKEN=abc hcloud --context alethia-e2e server delete box'
	bk hcloud 1 "$wt" 'hcloud --context alethia-console-prod server delete box'
	has 'a server delete takes a snapshot image first' image.txt 'Image 42'
	bk hcloud 1 "$wt" 'hcloud --context alethia-console-prod server rebuild box --image x'
	t block "$wt" 'hcloud --context alethia-console-prod server delete ghost'
	bk hcloud 0 "$wt" 'hcloud --context alethia-console-prod firewall delete fw'
	bk hcloud 0 "$wt" 'hcloud --context alethia-e2e server delete e2e-box'
	bk hcloud 0 "$wt" 'hcloud --context=alethia-sandbox server delete sandbox'
	bk hcloud 0 "$wt" 'HCLOUD_CONTEXT=alethia-e2e hcloud server delete e2e-box'
	t allow "$wt" 'hcloud server list'
	t allow "$wt" 'aws ec2 terminate-instances --instance-ids i-1'
	t allow "$wt" 'aws --profile x s3 rm s3://bucket/key'
	t allow "$wt" 'aws s3 sync . s3://b --delete'
	t allow "$wt" 'aws rds delete-db-instance --db-instance-identifier x --final-db-snapshot-identifier x-final'
	t block "$wt" 'aws rds delete-db-instance --db-instance-identifier x --skip-final-snapshot'
	bk aws 1 "$wt" 'aws --region eu-central-1 ec2 delete-volume --volume-id vol-1'
	has 'a volume delete takes an EBS snapshot first' snapshot.json snap-1
	check 'the snapshot is taken in the same region' grep -q 'aws --region eu-central-1 ec2 create-snapshot --volume-id vol-1' "$tmp/calls.log"
	t block "$wt" 'aws ec2 delete-volume --volume-id $V'
	t block "$wt" 'aws secretsmanager delete-secret --secret-id x --force-delete-without-recovery'
	t allow "$wt" 'aws secretsmanager delete-secret --secret-id x --recovery-window-in-days 7'
	t allow "$wt" 'aws ec2 describe-instances'
	t allow "$wt" 'aws s3 ls'
	t allow "$wt" 'gcloud compute instances delete vm-1 --zone x'
	t allow "$wt" 'az group delete -n rg --yes'
	t allow "$wt" 'aliyun ecs DeleteInstance --InstanceId i-1'
	bk kubernetes 0 "$wt" 'kubectl --context kind-alethia delete pod x'
	bk kubernetes 0 "$wt" 'kubectl --context=gke-alethia-e2e-1 delete ns x'
	bk kubernetes 1 "$wt" 'kubectl --context prod delete ns x --grace-period 0 --force'
	has 'a delete exports the objects first' objects.yaml 'kind: List'
	check 'the export is a get of the same objects' grep -q 'kubectl --context prod get ns x -o yaml' "$tmp/calls.log"
	bk kubernetes 1 "$wt" 'kubectl delete ns x'
	bk kubernetes 0 "$wt" 'kubectl delete ns x' STUB_KUBE_CONTEXT=kind-dev
	t block "$wt" 'kubectl --context prod delete ns ghost'
	t allow "$wt" 'kubectl drain node-1'
	t allow "$wt" 'kubectl apply -f x.yaml --prune -l app=x'
	t allow "$wt" 'kubectl get pods'
	bk kubernetes 1 "$wt" 'helm uninstall argo -n argocd'
	has 'helm uninstall saves the release' release.txt MANIFEST
	t block "$wt" 'helm uninstall $R'
	bk kubernetes 0 "$wt" 'helm uninstall argo --kube-context kind-x'

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
rm -rf ~/.ssh
EOF"
	t block "$wt" "cat <<EOF | sh
rm -rf ~/.ssh
EOF"
	t allow "$wt" 'gh issue comment 1 --body "Done.
hcloud server delete was run by the maintainer.
git push origin main is refused."'
	t allow "$wt" 'gh issue close 1 --comment "Remove them with \`hcloud ssh-key delete <id>\` in the e2e project."'
	t block "$wt" 'echo "x `hcloud server delete box` y"'
	t allow "$wt" 'gh pr create --body "a \"quoted\" word
hcloud server delete box
done"'
	t block "$wt" 'gh pr create --body "a \"quoted\" word" && rm -rf ~/.ssh'
	t block "$wt" "read x <<<word
rm -rf ~/.ssh"
	t block "$wt" "cat > /tmp/x <<EOF
data
EOF
rm -rf ~/.ssh"

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
	bk tfstate 1 "$repo" "rm -rf $tmp/wt-tf"
	has 'rm -rf of a worktree copies its state out' "files$tmp/wt-tf/infra/sandbox/terraform.tfstate"
	bk tfstate 1 "$repo" "git worktree remove --force $tmp/wt-tf"
	bk tfstate 1 "$repo" "git worktree remove $tmp/wt-tf"
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
	ids="$(grep -vE '^[[:space:]]*#' "$self" | grep -oE '(refuse|snapshot|snap|pin|backup) [RSB]-[A-Z]+' | awk '{print $2}' | sort -u)"
	for id in $ids; do
		copy="$dir/guard-destroy.sh"
		sed -E "s/(refuse|snapshot|snap|pin|backup) $id( |\$)/true $id\\2/g" "$self" >"$copy"
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
