# shellcheck shell=bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# scrub.sh — the proof-bundle secret scrub (BYOC A0.4), a text-level port of the
# runner's A0.0 metadata denylist (apps/runner/internal/agent/output_scrub.go's
# `sensitiveOutputSubstrings`). It is SOURCED by capture-proof.sh; it is not executable
# on its own except for `--self-test`.
#
# Two jobs:
#   scrub_stream       — reads stdin, writes a scrubbed copy to stdout (redacts secret
#                        literals, PEM private-key blocks, and denylisted key:value lines).
#   assert_grep_clean  — a fail-closed tripwire: greps a finished bundle dir and exits
#                        non-zero if ANY secret pattern survived (the step then goes red).
#
# Program invariant 2 (byoc-proof-program.md): nothing the nightly uploads may carry
# unscrubbed secret material. The runner already scrubs execution_metadata at the source
# (A0.0); this is the belt-and-suspenders for everything ELSE the proof bundle captures
# (kubectl output, the runner log tail, the receipt pulled from the DB) — captured text
# that never went through the Go scrub. KEEP THE DENYLIST IN SYNC with output_scrub.go.

# The exact-value secrets to redact wherever they appear (newline-separated). The caller
# fills this from the cloud token(s) in the environment (HCLOUD_TOKEN, E2E_GIT_TOKEN, …)
# BEFORE calling scrub_stream — an exact-string redaction is the strongest guarantee, so a
# token that leaked into a log line or a manifest is caught even if its key is not on the
# denylist. Never printed; only ever matched.
: "${SCRUB_LITERALS:=}"

# scrub_stream redacts, from stdin → stdout:
#   1. any exact secret literal in $SCRUB_LITERALS (e.g. the raw HCLOUD_TOKEN value);
#   2. the body of any PEM `... PRIVATE KEY ...` block (client keys, SSH keys);
#   3. the VALUE of any `key: value` / `key = value` / `"key": value` line whose key
#      contains a denylisted token (kubeconfig / talosconfig / *client[_-]key /
#      *private[_-]key / *password / *_token / *secret_value / *access_key / *manifest …).
# The key is kept (so the proof still shows WHICH field existed) — only the value dies.
scrub_stream() {
	perl -CSDA -ne '
		BEGIN {
			@lits = grep { length } split /\n/, ($ENV{SCRUB_LITERALS} // "");
			# Denylist tokens — a text mirror of output_scrub.go sensitiveOutputSubstrings.
			$den = qr/(?:kubeconfig|kube_config|talosconfig|client[_-]?key|client[_-]?certificate|private[_-]?key|client[_-]?secret|secret[_-]?value|secret[_-]?key|access[_-]?key|password|token|manifest)/i;
			$inkey = 0;
		}
		# (2) PEM private-key block: redact the whole body, not just the markers.
		if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/) { $inkey = 1; print "[REDACTED-PRIVATE-KEY]\n"; next; }
		if ($inkey) { if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/) { $inkey = 0; } next; }
		# (1) exact secret literals anywhere on the line.
		for my $l (@lits) { s/\Q$l\E/[REDACTED-SECRET]/g; }
		# (3) denylisted key -> redact its value (double-quoted or bare key; : or = sep).
		s/^(\s*["]?[\w.\-]*$den[\w.\-]*["]?\s*[:=]\s*).+$/$1\[REDACTED\]/;
		print;
	'
}

# scrub_file scrubs a file IN PLACE (used after capturing raw kubectl/log output).
scrub_file() {
	local f="$1" tmp
	tmp="$(mktemp)"
	scrub_stream <"$f" >"$tmp"
	mv "$tmp" "$f"
}

# assert_grep_clean is the fail-closed tripwire over a FINISHED bundle dir. It re-greps
# for the same three secret shapes and exits non-zero if any survived a scrub (or was
# never scrubbed) — turning a leak into a red step instead of a committed secret. It is
# deliberately independent of scrub_stream (a second pair of eyes), and it ignores its own
# `[REDACTED…]` placeholders.
assert_grep_clean() {
	local dir="$1" rc=0 lit hits
	# 1) Exact secret literals must not appear at all.
	while IFS= read -r lit; do
		[ -z "$lit" ] && continue
		if grep -rIqF -- "$lit" "$dir" 2>/dev/null; then
			echo "::error::proof-scrub: a secret LITERAL value survived into the proof bundle ($dir)" >&2
			rc=1
		fi
	done <<<"${SCRUB_LITERALS:-}"
	# 2) No PEM private keys.
	if grep -rIqE -- '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----' "$dir" 2>/dev/null; then
		echo "::error::proof-scrub: a PEM PRIVATE KEY survived into the proof bundle ($dir)" >&2
		rc=1
	fi
	# 3) Any denylisted key still carrying a real (non-REDACTED) value.
	hits="$(grep -rIhnE -- '(client[_-]?key|client-key-data|private[_-]?key|talosconfig|kubeconfig|kube_config|password|secret[_-]?value|secret[_-]?key|access[_-]?key|[_-]token)["]?[[:space:]]*[:=][[:space:]]*[^[:space:]]' "$dir" 2>/dev/null | grep -v 'REDACTED' || true)"
	if [ -n "$hits" ]; then
		echo "::error::proof-scrub: a denylisted key still carries a plaintext value in the proof bundle ($dir):" >&2
		printf '%s\n' "$hits" | head -5 >&2
		rc=1
	fi
	return "$rc"
}

# --self-test: prove the scrub is NON-VACUOUS. Seeds a fake secret of every shape, runs it
# through scrub_stream, and asserts (a) the raw secret is gone, (b) a non-secret sentinel
# survives, (c) assert_grep_clean passes on the scrubbed dir, and (d) it FAILS on the
# un-scrubbed original (so the tripwire has teeth). Runnable in CI + locally.
_scrub_self_test() {
	local work scrubbed
	work="$(mktemp -d)"
	# shellcheck disable=SC2064
	trap "rm -rf '$work'" RETURN
	# Obviously-fake placeholders (no real provider prefix, low entropy) so the secret
	# scanner never mistakes them for live credentials while still exercising the scrub.
	local fake_token="hcloud-FAKE-PLACEHOLDER-9f1c3b2a-DO-NOT-LEAK"
	local fake_git="git-FAKE-PLACEHOLDER-9f1c3b2a-DO-NOT-LEAK"
	# The PEM marker is ASSEMBLED at runtime (never a literal in this source file) so the
	# repo secret scanner doesn't flag the test fixture — the generated file below still
	# carries the real `... PRIVATE KEY ...` marker the scrub must catch.
	local pk="PRIVATE KEY"
	cat >"$work/raw.txt" <<EOF
node-1   Ready    control-plane   10m   v1.34.0        # a genuine, non-secret line
HCLOUD_TOKEN=$fake_token
argocd_admin_password: $fake_git
client-key-data: FAKE-CLIENT-KEY-VALUE-should-be-redacted-by-key
password: FAKE-PASSWORD-should-be-redacted-by-key
-----BEGIN EC $pk-----
FAKE-KEY-BODY-should-never-survive
-----END EC $pk-----
KEEP-ME-SENTINEL-non-secret-marker
EOF

	SCRUB_LITERALS="$(printf '%s\n%s\n' "$fake_token" "$fake_git")"
	export SCRUB_LITERALS

	# The un-scrubbed original MUST trip the tripwire (proves it is not vacuous).
	if assert_grep_clean "$work" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: assert_grep_clean passed on UN-scrubbed input (tripwire is vacuous)" >&2
		return 1
	fi

	mkdir -p "$work/out"
	scrubbed="$work/out/scrubbed.txt"
	scrub_stream <"$work/raw.txt" >"$scrubbed"

	# The raw secrets must be gone; the non-secret sentinel must survive.
	if grep -qF "$fake_token" "$scrubbed" || grep -qF "$fake_git" "$scrubbed" || grep -qiF "FAKE-PASSWORD" "$scrubbed" || grep -qiF "FAKE-KEY-BODY" "$scrubbed"; then
		echo "SELF-TEST FAIL: a seeded secret survived scrub_stream" >&2
		return 1
	fi
	if ! grep -qF "KEEP-ME-SENTINEL-non-secret-marker" "$scrubbed"; then
		echo "SELF-TEST FAIL: scrub_stream ate a non-secret line (over-broad)" >&2
		return 1
	fi
	# The scrubbed bundle must pass the tripwire.
	if ! assert_grep_clean "$work/out"; then
		echo "SELF-TEST FAIL: assert_grep_clean flagged a correctly-scrubbed bundle" >&2
		return 1
	fi
	echo "scrub self-test OK: seeded secrets redacted, sentinel kept, tripwire non-vacuous"
	return 0
}

# Allow `bash demos/proofs/scrub.sh --self-test` even though the file is normally sourced.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	set -euo pipefail
	case "${1:-}" in
	--self-test) _scrub_self_test ;;
	*)
		echo "scrub.sh is a sourced library; the only standalone command is --self-test" >&2
		exit 2
		;;
	esac
fi
