#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `pnpm backups:ls [<kind>] [--limit N]` — list the backups .claude/hooks/guard-destroy.sh took
# before letting a destructive command run, newest first.
#
# Each lives in ~/.alethia/backups/<kind>/<UTC timestamp>/ with a MANIFEST (what ran, what was
# saved, how to restore it). This prints the MANIFEST's `what` and `saved` lines and the size —
# never a backup's contents, which can hold terraform state, a database dump or a release asset.
# Kinds: remote-refs, gh-repo, gh-release, gh-issue, gh-api, tfstate, db, docker-volumes, hcloud,
# aws, kubernetes. The local git snapshots are refs, not files: `git for-each-ref refs/safety/`.
set -euo pipefail

root="${HOME}/.alethia/backups"
kind=""
limit=50
while [ $# -gt 0 ]; do
	case "$1" in
	--limit)
		limit="${2:?--limit needs a number}"
		shift
		;;
	-h | --help)
		sed -n '5,13p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*) kind="$1" ;;
	esac
	shift
done

if [ ! -d "$root" ]; then
	echo "no backups yet ($root does not exist)"
	exit 0
fi

# field <manifest> <name> — the value of one `name: value` line.
field() { sed -n "s/^$2: //p" "$1" | head -1; }

# One line per backup directory: "<timestamp>\t<kind>\t<dir>", sorted newest first across kinds.
list="$(
	for d in "$root"/${kind:-*}/*/; do
		[ -d "$d" ] || continue
		d="${d%/}"
		k="${d%/*}"
		printf '%s\t%s\t%s\n' "${d##*/}" "${k##*/}" "$d"
	done | sort -r | head -n "$limit"
)"
if [ -z "$list" ]; then
	echo "no backups${kind:+ of kind '$kind'} in $root"
	exit 0
fi

printf '%-28s %-15s %7s  %s\n' WHEN KIND SIZE WHAT
while IFS=$'\t' read -r ts k d; do
	m="$d/MANIFEST"
	what="?"
	saved=""
	if [ -f "$m" ]; then
		what="$(field "$m" what)"
		saved="$(field "$m" saved)"
	fi
	size="$(du -sh "$d" 2>/dev/null | cut -f1)"
	printf '%-28s %-15s %7s  %s\n' "$ts" "$k" "$size" "$what"
	[ -n "$saved" ] && printf '%-28s %-15s %7s    saved: %s\n' "" "" "" "$saved"
	printf '%-28s %-15s %7s    %s\n' "" "" "" "$d"
done <<<"$list"
echo ""
echo "restore: read the 'restore:' line of <dir>/MANIFEST"
