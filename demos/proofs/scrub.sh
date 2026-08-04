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

# scrub_literals_from_env exports SCRUB_LITERALS from every credential the run holds. Both
# capture-proof.sh and scrub-runner-log.sh need the identical list — when they drifted, one
# artifact was scrubbed and its sibling was not (#1854). One definition, two callers.
#
# The Alibaba trio is listed under BOTH names on purpose. One AssumeRoleWithOIDC exchange is
# exported six times because the alicloud OpenTofu provider and the aliyun CLI disagree about the
# variable names (ALICLOUD_* vs ALIBABA_CLOUD_*), and a literal list that covered only one spelling
# would scrub the provider's copy while publishing the CLI's — the exact half-covered shape of
# #1854. They are short-lived STS credentials, which limits the exposure but does not remove it.
scrub_literals_from_env() {
	local v literals=""
	for v in "${HCLOUD_TOKEN:-}" "${E2E_GIT_TOKEN:-}" "${ALETHIA_E2E_GIT_TOKEN:-}" \
		"${AWS_SECRET_ACCESS_KEY:-}" "${AWS_SESSION_TOKEN:-}" \
		"${ALICLOUD_SECRET_KEY:-}" "${ALICLOUD_SECURITY_TOKEN:-}" "${ALICLOUD_ACCESS_KEY:-}" \
		"${ALIBABA_CLOUD_ACCESS_KEY_SECRET:-}" "${ALIBABA_CLOUD_SECURITY_TOKEN:-}" \
		"${ALIBABA_CLOUD_ACCESS_KEY_ID:-}"; do
		[ -n "$v" ] && literals+="$v"$'\n'
	done
	SCRUB_LITERALS="$literals"
	export SCRUB_LITERALS
}

# scrub_stream redacts, from stdin → stdout:
#   1. any exact secret literal in $SCRUB_LITERALS (e.g. the raw HCLOUD_TOKEN value);
#   2. the body of any PEM `... PRIVATE KEY ...` block (client keys, SSH keys);
#   3. the VALUE of any `key: value` / `key = value` / `"key": value` line whose key
#      contains a denylisted token (kubeconfig / talosconfig / *client[_-]key /
#      *private[_-]key / *password / *_token / *secret_value / *access_key / *manifest …).
#   4. the same denylisted keys appearing INSIDE a JSON object mid-line, in either of the
#      two shapes OpenTofu emits: `"key":"value"` and `"key":{"value":"…"}`.
# The key is kept (so the proof still shows WHICH field existed) — only the value dies.
#
# Rule (4) exists because rule (3) is LINE-ANCHORED (`^`), and a tofu `show -json` plan is one
# enormous single line. #1854: `"hcloud_token":{"value":"<live token>"}` sat mid-line in the
# runner log and rule (3) could not see it — only the exact-literal rule (1) caught it, and
# rule (1) only covers the five credentials the caller happens to export. Any sensitive tfvar
# NOT in SCRUB_LITERALS (hetzner_s3_secret_key, rds password, …) had no cover at all.
#
# Note `sensitive = true` on the variable does NOT help here: OpenTofu applies sensitivity to
# `planned_values`/`resource_changes` via `sensitive_values`, but emits the top-level
# `variables` map RAW. The scrub is the only control over that surface.
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
		# (4) JSON-embedded, mid-line. Wrapped form FIRST: `"key":{"value":"…"}` is what a tofu
		#     plan JSON emits for a root variable, and the bare form would otherwise match its
		#     inner `"value":"…"` only by luck of ordering.
		s/(["][\w.\-]*$den[\w.\-]*["]\s*:\s*\{\s*["]value["]\s*:\s*)"(?:[^"\\]|\\.)*"/$1"[REDACTED]"/g;
		s/(["][\w.\-]*$den[\w.\-]*["]\s*:\s*)"(?:[^"\\]|\\.)*"/$1"[REDACTED]"/g;
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
	# 3) Any denylisted key still carrying a real value — one neither WE redacted ("REDACTED")
	#    nor OpenTofu already withheld.
	#
	#    `(sensitive value)` is tofu's OWN redaction marker: a plan/apply line reading
	#    `+ kubeconfig = (sensitive value)` is tofu telling you it withheld the value, and it
	#    carries no secret. Without this exclusion the tripwire fires on EVERY tofu log — the
	#    hetzner template alone emits kubeconfig, talosconfig and client_key in exactly that
	#    shape — so a perfectly clean bundle is reported as secret-bearing. That is not a
	#    harmless false alarm: a caller treating the tripwire as fatal discards a good bundle.
	#
	#    A `tofu show -json` plan is the other shape that made this rule fire on a clean bundle,
	#    and it did so on EVERY azure run (#1937): the plan's `configuration` and
	#    `sensitive_values` sections name every sensitive attribute, with a STRUCTURAL value
	#    rather than a secret one —
	#      "admin_password":{"sensitive":true,"expression":…,"references":…}
	#      "client_key":{"references":[…]}
	#      "kube_config":true
	#    The old rule required only a single non-space character after the separator, so `t` of
	#    `true` and `{` of `{"sensitive"` both matched. The azure leg therefore lost its runner
	#    log on every run — a fail-closed guard that always fails is not fail-closed, it is off.
	#
	#    So: capture enough of the value to classify it (stopping at `,` or `}`, because compact
	#    JSON has no spaces to stop at), then drop the shapes that are metadata BY CONSTRUCTION.
	#    Both exclusions are deliberately narrow, because every one of them is a hole if it is
	#    wider than the shape it names:
	#
	#      a) the value is EXACTLY the literal `true`/`false`/`null` (or tofu's own
	#         `(sensitive value)` marker). Anchored with `$` to the end of the captured
	#         occurrence, so a real credential that merely STARTS with those letters —
	#         `token: null+Yg==` — is still flagged. An unanchored form excluded it.
	#      b) the value is an object whose FIRST key is `sensitive`/`references`/`expression`
	#         AND whose own value is a bool/array/object — never a string.
	#
	#    `constant_value` is NOT on that list, deliberately: `"password":{"constant_value":"…"}`
	#    is precisely where a hardcoded secret in a .tf shows up in the plan JSON's
	#    `configuration` section. Excluding it would have hidden the one shape most worth
	#    catching. Nothing in the real azure bundle needed it.
	#
	#    Matching with -o rather than -n is also what lets the message name the KEY: with -n,
	#    grep prefixes `<lineno>:` and the sanitising sed below cut at THAT colon, so the operator
	#    was told `2: [value withheld]` — a line number and nothing else.
	hits="$(grep -rIhoE -- '["]?[A-Za-z0-9_.-]*(client[_-]?key|client-key-data|private[_-]?key|talosconfig|kubeconfig|kube_config|password|secret[_-]?value|secret[_-]?key|access[_-]?key|[_-]token)[A-Za-z0-9_.-]*["]?[[:space:]]*[:=][[:space:]]*[^[:space:],}]{1,24}' "$dir" 2>/dev/null |
		grep -v 'REDACTED' |
		grep -vE '[:=][[:space:]]*(\(sensitive|true|false|null)$' |
		grep -vE '[:=][[:space:]]*\{["]?(sensitive|references|expression)["]?[[:space:]]*:[[:space:]]*(true|false|null|\[|\{)' || true)"
	if [ -n "$hits" ]; then
		echo "::error::proof-scrub: a denylisted key still carries a plaintext value in the proof bundle ($dir):" >&2
		# Print the KEY only. This used to print the whole matching line, which meant the tripwire
		# pasted the surviving secret into the CI log — republishing the leak into the very place
		# the scrub exists to keep clean. Found while testing the #1854 fail-closed path against a
		# deliberately weakened scrub.
		printf '%s\n' "$hits" | sed -E 's/[[:space:]]*[:=][[:space:]]*.*$/ = [value withheld]/' | sort -u | head -5 >&2
		rc=1
	fi
	# 4) The same denylisted keys nested in JSON mid-line — the shape a tofu `show -json` plan
	#    emits for a root variable. Check (3) matches at most one occurrence per line and reads
	#    as `key<sep>value`; a plan JSON is ONE line carrying hundreds of pairs, so #1854's
	#    `"hcloud_token":{"value":"…"}` slipped past it. Match the value being a non-empty
	#    string that is not our own placeholder.
	hits="$(grep -rIhoE -- '"[A-Za-z0-9_.-]*(client[_-]?key|private[_-]?key|talosconfig|kubeconfig|kube_config|password|secret[_-]?value|secret[_-]?key|access[_-]?key|token)[A-Za-z0-9_.-]*"[[:space:]]*:[[:space:]]*(\{[[:space:]]*"value"[[:space:]]*:[[:space:]]*)?"[^"]+"' "$dir" 2>/dev/null | grep -v 'REDACTED' || true)"
	if [ -n "$hits" ]; then
		echo "::error::proof-scrub: a denylisted key carries a plaintext value inside JSON ($dir):" >&2
		# Print the KEY only — never the surviving value, or the tripwire republishes the leak
		# into the workflow log it is meant to protect.
		printf '%s\n' "$hits" | sed -E 's/"[[:space:]]*:.*$/"/' | sort -u | head -5 >&2
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
	# #1854's shape: a secret nested in a ONE-LINE tofu plan JSON. Deliberately NOT added to
	# SCRUB_LITERALS below — a run only exports the credentials scrub_literals_from_env names, so
	# any other sensitive tfvar has to be caught by the key rule alone. If this survives, the key
	# rule is not covering the JSON shape and the literal rule is silently carrying the whole scrub.
	local fake_planjson="planjson-FAKE-PLACEHOLDER-9f1c3b2a-DO-NOT-LEAK"
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
{"format_version":"1.2","variables":{"hcloud_token":{"value":"$fake_planjson"},"region":{"value":"KEEP-ME-PLANJSON-REGION"}},"hetzner_s3_secret_key":"$fake_planjson"}
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
	# #1854: the JSON-nested secret must die on the KEY rule alone (it is not a literal), in
	# both the wrapped `{"value":…}` and bare forms.
	if grep -qF "$fake_planjson" "$scrubbed"; then
		echo "SELF-TEST FAIL: a JSON-nested secret survived scrub_stream (the #1854 shape)" >&2
		return 1
	fi
	# …and its non-secret siblings on that same line must survive, or the rule is eating the
	# whole plan JSON instead of the one value.
	if ! grep -qF "KEEP-ME-PLANJSON-REGION" "$scrubbed"; then
		echo "SELF-TEST FAIL: the JSON rule ate a non-secret sibling value (over-broad)" >&2
		return 1
	fi
	# The scrubbed bundle must pass the tripwire.
	if ! assert_grep_clean "$work/out"; then
		echo "SELF-TEST FAIL: assert_grep_clean flagged a correctly-scrubbed bundle" >&2
		return 1
	fi

	# ── The tripwire must be non-vacuous AND not over-broad (#1937). ──
	# A `tofu show -json` plan names every sensitive attribute in its `configuration` and
	# `sensitive_values` sections, with a STRUCTURAL value — an object keyed by
	# sensitive/expression/references, or the bare literal `true`. The tripwire used to require
	# only one non-space character after the separator, so all of these matched, and the azure leg
	# failed its capture on EVERY run and lost its runner log with it. A guard that always fires is
	# off, not fail-closed — so pin BOTH directions on the same fixture.
	local meta="$work/meta"
	mkdir -p "$meta"
	cat >"$meta/plan.json" <<'EOF'
{"configuration":{"root_module":{"resources":[{"expressions":{"administrator_password":{"references":["random_password.db"]},"admin_password":{"sensitive":true,"expression":{},"references":[]},"primary_access_key":{"sensitive":true,"expression":{},"references":[]},"client_key":{"references":["azurerm_kubernetes_cluster.this"]}}}]}},"sensitive_values":{"kube_config":true,"kube_config_raw":true,"client_key":false}}
EOF
	if ! assert_grep_clean "$meta" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: assert_grep_clean flagged a plan JSON's structural metadata (over-broad — this is #1937)" >&2
		return 1
	fi
	# …and a REAL secret in the very same shapes must still trip it, or the narrowing went too far.
	local meta_bad="$work/meta-bad"
	mkdir -p "$meta_bad"
	cat >"$meta_bad/plan.json" <<'EOF'
{"variables":{"administrator_password":{"value":"planjson-FAKE-PLACEHOLDER-real-secret-DO-NOT-LEAK"}},"sensitive_values":{"kube_config":true}}
EOF
	if assert_grep_clean "$meta_bad" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: assert_grep_clean passed a REAL secret sitting beside plan-JSON metadata" >&2
		return 1
	fi
	# The two shapes the narrowing must NOT swallow, pinned individually because each is a hole if
	# its exclusion is a character wider than the metadata it names:
	#   - a hardcoded secret in the plan JSON's `configuration` section, which appears under
	#     `constant_value` — the one key deliberately left off the metadata list;
	#   - a credential whose value merely BEGINS with `null`/`true`/`false`.
	local meta_edge
	for meta_edge in \
		'{"expressions":{"administrator_password":{"constant_value":"planjson-FAKE-PLACEHOLDER-hardcoded-DO-NOT-LEAK"}}}' \
		'{"kube_config_token":"null+FAKE-PLACEHOLDER-base64ish-DO-NOT-LEAK"}'; do
		rm -f "$meta_bad/plan.json" "$meta_bad/plain.txt" "$meta_bad/edge.json"
		printf '%s\n' "$meta_edge" >"$meta_bad/edge.json"
		if assert_grep_clean "$meta_bad" >/dev/null 2>&1; then
			echo "SELF-TEST FAIL: assert_grep_clean passed a real secret in shape: ${meta_edge:0:40}…" >&2
			return 1
		fi
	done
	rm -f "$meta_bad/edge.json"
	cat >"$meta_bad/plan.json" <<'EOF'
{"variables":{"administrator_password":{"value":"planjson-FAKE-PLACEHOLDER-real-secret-DO-NOT-LEAK"}},"sensitive_values":{"kube_config":true}}
EOF
	# The failure message must name the KEY. It used to print grep's `-n` line-number prefix and
	# cut the sanitising sed at THAT colon, so the operator was told `2: [value withheld]` — a line
	# number and nothing else, which is why an azure capture failure could not be diagnosed.
	cat >"$meta_bad/plain.txt" <<'EOF'
argocd_admin_password: FAKE-PASSWORD-should-be-named-by-the-tripwire
EOF
	# Captured into a variable, not piped: the function legitimately returns 1 here, and under
	# `set -o pipefail` a pipeline carrying that 1 would make every assertion below read backwards.
	local msg
	msg="$(assert_grep_clean "$meta_bad" 2>&1 || true)"
	if ! grep -q 'argocd_admin_password' <<<"$msg"; then
		echo "SELF-TEST FAIL: the tripwire's message does not name the offending key" >&2
		return 1
	fi
	# …and it must still never print the value itself.
	if grep -q 'FAKE-PASSWORD-should-be-named-by-the-tripwire' <<<"$msg"; then
		echo "SELF-TEST FAIL: the tripwire republished the surviving value into its own message" >&2
		return 1
	fi

	# ── The HARVEST, not just the redaction (#1875). ──
	# Everything above builds SCRUB_LITERALS by hand, so it proves scrub_stream redacts what it is
	# GIVEN and says nothing about whether the run's actual credentials get into that list. That is
	# the #1854 gap exactly: the scrub worked, the list was short. So drive the real harvester and
	# assert every credential a leg can hold comes out the other side.
	local saved_literals="${SCRUB_LITERALS:-}" name missed=""
	local -a cred_vars=(
		HCLOUD_TOKEN E2E_GIT_TOKEN ALETHIA_E2E_GIT_TOKEN
		AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
		# Six names, one AssumeRoleWithOIDC exchange: the alicloud OpenTofu provider and the aliyun
		# CLI disagree about the spelling, and covering one spelling scrubs the provider's copy
		# while publishing the CLI's.
		ALICLOUD_ACCESS_KEY ALICLOUD_SECRET_KEY ALICLOUD_SECURITY_TOKEN
		ALIBABA_CLOUD_ACCESS_KEY_ID ALIBABA_CLOUD_ACCESS_KEY_SECRET ALIBABA_CLOUD_SECURITY_TOKEN
	)
	for name in "${cred_vars[@]}"; do
		export "$name=harvest-FAKE-PLACEHOLDER-${name}-DO-NOT-LEAK"
	done
	scrub_literals_from_env
	for name in "${cred_vars[@]}"; do
		grep -qF "harvest-FAKE-PLACEHOLDER-${name}-DO-NOT-LEAK" <<<"$SCRUB_LITERALS" || missed+=" $name"
	done
	for name in "${cred_vars[@]}"; do
		unset "$name"
	done
	SCRUB_LITERALS="$saved_literals"
	export SCRUB_LITERALS
	if [ -n "$missed" ]; then
		echo "SELF-TEST FAIL: scrub_literals_from_env does not harvest:${missed}" >&2
		echo "  A credential the run HOLDS but the literal list never sees is the #1854 shape." >&2
		return 1
	fi

	echo "scrub self-test OK: seeded secrets redacted, sentinel kept, tripwire non-vacuous, ${#cred_vars[@]} credentials harvested"
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
