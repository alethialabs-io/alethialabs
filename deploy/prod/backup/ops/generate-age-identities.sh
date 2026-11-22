#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Creates the three age identities the off-box backup encrypts to (BKP-L1, #7243), on the
# operator's own machine. Never on the production box.
#
#   generate-age-identities.sh --out DIR [--dry-run]
#   generate-age-identities.sh --self-test
#
#   --out DIR    where the private keys go: DIR/alethia-backup-{primary,breakglass,drill}.agekey,
#                each 0600 in a 0700 DIR. DIR must not be inside a git work tree, so a private key
#                cannot be committed by accident.
#   --dry-run    say what would be created; create nothing
#
# Prints ONLY public keys: one line per identity, then the BACKUP_AGE_RECIPIENTS line for
# backup.env. A private key is never written to stdout or stderr.
#
# Idempotent: an identity file that already exists is never overwritten; its public key is derived
# from it (`age-keygen -y`) and printed again, so a re-run gives the same recipients line.
#
# After it runs: primary goes to the password manager; breakglass to the password manager AND a
# second, separate place; drill into the backup account's Secrets Manager secret. Then delete DIR.

set -euo pipefail

NAMES=(primary breakglass drill)
AGE_KEYGEN="${AGE_KEYGEN:-age-keygen}" # overridden by --self-test only
AGE_PUBLIC_RE='^age1[02-9ac-hj-np-z]{58}$'
SELFTEST_TMP=""

#######################################
# Prints usage.
#######################################
usage() {
	sed -n '5,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

#######################################
# Prints an error on stderr and exits with the given code (default 1).
#######################################
die() {
	printf 'error: %s\n' "$1" >&2
	exit "${2:-1}"
}

#######################################
# Succeeds when DIR (or its nearest existing parent) is inside a git work tree.
#######################################
inside_git_tree() {
	local d="$1"
	while [ ! -d "$d" ]; do d="$(dirname "$d")"; done
	git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

#######################################
# Prints the public key of the identity FILE, checked for shape. Prints nothing secret.
#######################################
public_key_of() {
	local pub
	pub="$("$AGE_KEYGEN" -y "$1" 2>/dev/null)" || die "could not read the public key of $1"
	[[ "$pub" =~ $AGE_PUBLIC_RE ]] || die "$1 did not yield an age X25519 public key"
	printf '%s' "$pub"
}

#######################################
# Creates (or re-reads) the three identities under OUT and prints the public keys.
#######################################
generate() {
	local out="$1" dry="$2" name f pub recipients=""
	command -v "$AGE_KEYGEN" >/dev/null 2>&1 || die "'age-keygen' is not installed (brew install age, or apt-get install age)"
	inside_git_tree "$out" && die "--out is inside a git work tree; choose a directory outside any repository"
	if [ "$dry" -eq 1 ]; then
		for name in "${NAMES[@]}"; do
			f="$out/alethia-backup-$name.agekey"
			if [ -e "$f" ]; then printf 'would keep   %s (exists)\n' "$f"; else printf 'would create %s\n' "$f"; fi
		done
		printf '\nDRY RUN: nothing was created\n'
		return 0
	fi
	(umask 077 && mkdir -p "$out")
	chmod 700 "$out"
	for name in "${NAMES[@]}"; do
		f="$out/alethia-backup-$name.agekey"
		if [ ! -e "$f" ]; then
			# age-keygen writes the identity to the file and a "Public key:" note to stderr; the note
			# is discarded and the key derived from the file instead, so one path prints keys.
			(umask 077 && "$AGE_KEYGEN" -o "$f" 2>/dev/null) || die "age-keygen failed for $name"
		fi
		chmod 600 "$f"
		pub="$(public_key_of "$f")"
		printf '%-11s %s\n' "$name" "$pub"
		recipients="${recipients:+$recipients }$pub"
	done
	printf '\nBACKUP_AGE_RECIPIENTS="%s"\n' "$recipients"
}

#######################################
# Hermetic checks against a stand-in age-keygen: files, modes, idempotence, the repo refusal, and
# that no private key reaches the output. Every check counts toward the exit code.
#######################################
self_test() {
	local fails=0 tmp out1 out2 code
	tmp="$(mktemp -d)"
	SELFTEST_TMP="$tmp"
	trap 'rm -rf "$SELFTEST_TMP"' EXIT
	check() { # check <name> <got> <want>
		if [ "$2" = "$3" ]; then
			printf 'ok    %s\n' "$1"
		else
			printf 'FAIL  %s\n      got:  %q\n      want: %q\n' "$1" "$2" "$3"
			fails=$((fails + 1))
		fi
	}
	# The stand-in: `-o FILE` writes a fake secret plus a public key derived from a counter;
	# `-y FILE` prints the public key line from the file.
	cat >"$tmp/age-keygen" <<-'STUB'
		#!/usr/bin/env bash
		set -eu
		case "$1" in
			-o)
				n=$(( $(cat "${STUB_COUNTER}" 2>/dev/null || echo 0) + 1 )); echo "$n" >"${STUB_COUNTER}"
				c=$(printf 'qpzry9x8gf2tvdw0s3jn54khce6mua7l' | cut -c"$n")
				pub="age1$(printf "${c}%.0s" $(seq 58))"
				printf '# public key: %s\nAGE-SECRET-KEY-1SELFTESTSECRET%s\n' "$pub" "$n" >"$2"
				echo "Public key: $pub" >&2 ;;
			-y) sed -n 's/^# public key: //p' "$2" ;;
		esac
	STUB
	chmod +x "$tmp/age-keygen"
	export STUB_COUNTER="$tmp/counter"
	gen() { AGE_KEYGEN="$tmp/age-keygen" bash "${BASH_SOURCE[0]}" "$@"; }

	out1="$(gen --out "$tmp/keys" 2>&1)"
	check "three identity files" "$(find "$tmp/keys" -name '*.agekey' | wc -l | tr -d ' ')" 3
	check "the directory is 0700" "$(stat -c %a "$tmp/keys" 2>/dev/null || stat -f %Lp "$tmp/keys")" 700
	check "a key file is 0600" "$(stat -c %a "$tmp/keys/alethia-backup-drill.agekey" 2>/dev/null || stat -f %Lp "$tmp/keys/alethia-backup-drill.agekey")" 600
	check "no private key in the output" "$(grep -c 'AGE-SECRET-KEY' <<<"$out1")" 0
	check "three public keys and the recipients line" "$(grep -cE 'age1[02-9ac-hj-np-z]{58}' <<<"$out1")" 4
	check "the recipients line holds three keys" "$(sed -n 's/^BACKUP_AGE_RECIPIENTS="\(.*\)"$/\1/p' <<<"$out1" | wc -w | tr -d ' ')" 3
	out2="$(gen --out "$tmp/keys" 2>&1)"
	check "a re-run prints the same keys" "$out2" "$out1"
	check "a re-run creates no new identity" "$(cat "$STUB_COUNTER")" 3
	check "a dry run creates nothing" "$(gen --out "$tmp/none" --dry-run >/dev/null 2>&1; [ -e "$tmp/none" ] && echo created || echo absent)" absent
	mkdir -p "$tmp/repo" && git -C "$tmp/repo" init -q
	code=0
	gen --out "$tmp/repo/keys" >/dev/null 2>&1 || code=$?
	check "a directory inside a git work tree is refused" "$code" 1
	check "and nothing is written there" "$([ -e "$tmp/repo/keys" ] && echo written || echo absent)" absent

	if [ "$fails" -ne 0 ]; then
		printf '\n%s self-test assertion(s) failed\n' "$fails"
		return 1
	fi
	printf '\nall self-test assertions passed\n'
}

main() {
	local out="" dry=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--out) out="${2:-}"; shift 2 || die "--out needs a directory" 64 ;;
			--dry-run) dry=1; shift ;;
			--self-test) self_test; return ;;
			-h | --help) usage; return 0 ;;
			*) usage >&2; exit 64 ;;
		esac
	done
	[ -n "$out" ] || { usage >&2; exit 64; }
	generate "$out" "$dry"
}

main "$@"
