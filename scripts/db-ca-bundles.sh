#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The managed-database CA bundles the bootstrap Jobs verify a server against
# (packages/core/manifests/dbca, #6521). Each bundle is checked into the repo and pinned in
# dbca/SOURCES.json: the upstream URL of every certificate file it is built from, the sha256 of the
# bytes that URL served, and the sha256 of the assembled bundle. The Jobs never fetch anything at run
# time; this script is the only thing that talks to the upstream URLs.
#
#   scripts/db-ca-bundles.sh check    fetch every source and compare it with its pinned sha256.
#                                     Exit 1 names each source that changed upstream. Run by the
#                                     informational `db-ca-bundles` job of ci.yml: a rotation upstream
#                                     turns that job red, and nothing else waits on it.
#   scripts/db-ca-bundles.sh update   fetch every source, rebuild each bundle from them in the order
#                                     SOURCES.json lists, and rewrite the pinned hashes. Review the
#                                     diff (which roots were added or removed) before committing it.
#
# A source's format is `pem` (used verbatim) or `der` (converted with openssl). Requires curl, jq,
# openssl and sha256sum or shasum.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="$root/packages/core/manifests/dbca"
sources="$dir/SOURCES.json"
mode="${1:-}"

case "$mode" in
check | update) ;;
*)
	echo "usage: $0 check|update" >&2
	exit 2
	;;
esac

# sha256 prints the hex sha256 of a file.
sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

changed=0
updated="$(cat "$sources")"
nbundles="$(jq '.bundles | length' "$sources")"
for ((b = 0; b < nbundles; b++)); do
	file="$(jq -r ".bundles[$b].file" "$sources")"
	out="$work/$file"
	: >"$out"
	nsrc="$(jq ".bundles[$b].sources | length" "$sources")"
	for ((s = 0; s < nsrc; s++)); do
		url="$(jq -r ".bundles[$b].sources[$s].url" "$sources")"
		format="$(jq -r ".bundles[$b].sources[$s].format" "$sources")"
		pinned="$(jq -r ".bundles[$b].sources[$s].sha256" "$sources")"
		raw="$work/src-$b-$s"
		curl -fsSL --retry 3 --proto '=https' -o "$raw" "$url"
		got="$(sha256 "$raw")"
		if [ "$got" != "$pinned" ]; then
			echo "CHANGED UPSTREAM: $url (pinned $pinned, served $got) — bundle $file" >&2
			changed=1
		fi
		case "$format" in
		pem) cat "$raw" >>"$out" ;;
		der) openssl x509 -inform der -in "$raw" -outform pem >>"$out" ;;
		*)
			echo "$url: unknown format $format" >&2
			exit 2
			;;
		esac
		updated="$(jq --argjson b "$b" --argjson s "$s" --arg h "$got" '.bundles[$b].sources[$s].sha256 = $h' <<<"$updated")"
	done
	count="$(grep -c -- '-----BEGIN CERTIFICATE-----' "$out")"
	updated="$(jq --argjson b "$b" --arg h "$(sha256 "$out")" --argjson n "$count" '.bundles[$b].sha256 = $h | .bundles[$b].certificates = $n' <<<"$updated")"
	if [ "$mode" = update ]; then
		cp "$out" "$dir/$file"
	fi
done

if [ "$mode" = update ]; then
	printf '%s\n' "$updated" >"$sources"
	echo "rebuilt the bundles in $dir; review the diff before committing it"
	exit 0
fi
if [ "$changed" -ne 0 ]; then
	echo "A pinned CA source changed upstream. Run \`scripts/db-ca-bundles.sh update\`, review which roots changed, and open a PR." >&2
	exit 1
fi
echo "every pinned CA source matches upstream"
