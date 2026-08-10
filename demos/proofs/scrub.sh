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
		"${HETZNER_S3_ACCESS_KEY:-}" "${HETZNER_S3_SECRET_KEY:-}" \
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
#   4. the same denylisted keys appearing INSIDE a JSON object mid-line, in the shapes OpenTofu
#      emits: `"key":"value"`, `"key":{"value":"…"}`, `"key":{"constant_value":"…"}` and the
#      array forms `"key":["…"]` / `"key":{"value":["…"]}`.
#   4b. a DECLARATION carrying a secret — `"key":{"default":"…"}` for a variable whose name ENDS
#      in a denylisted token, and `"source":"git::https://user:TOKEN@host/repo"` for a module.
#   5. a denylisted BARE key mid-line — `…msg="apply failed" hcloud_token=abc…`, the shape a
#      logfmt line has. Rule (3) is line-anchored and cannot see it.
# The key is kept (so the proof still shows WHICH field existed) — only the value dies.
#
# Rules (4-`constant_value`), (4-array) and (5) close a gap that made the TRIPWIRE unsatisfiable
# (#1923 follow-up). assert_grep_clean flags a denylisted key carrying any non-structural value —
# correctly — but this scrubber could not redact those four shapes, so a leg carrying one had no
# way to ever produce a bundle: red on every run, with the secret sitting in plaintext until the
# capture deleted it. A tripwire that flags what the scrub cannot fix is a permanent outage, and
# the honest fix is to make the scrub cover the shape, not to stop flagging it.
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
			# TERMINAL denylist (#1954) — the token must END the key name. Used only by the
			# declaration rules (4b), which mirror assert_grep_clean check (3b) exactly: a rule
			# that redacts LESS than the tripwire flags makes the leg red forever, and one that
			# redacts MORE eats the evidence the artifact exists to carry. Same list as (3b).
			$dent = qr/(?:client[_-]?key|client-key-data|private[_-]?key|talosconfig|kubeconfig|kube_config|password|secret[_-]?value|secret[_-]?key|access[_-]?key|[_-]token)/i;
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
		#     `constant_value` is the same hazard one section over: a secret written as a literal in
		#     the .tf source lands in the plan JSON `configuration` block under that key, verbatim.
		#     assert_grep_clean deliberately does NOT excuse it, so covering only `value` left the
		#     shape most worth catching flagged-but-unredactable.
		s/(["][\w.\-]*$den[\w.\-]*["]\s*:\s*\{\s*["]value["]\s*:\s*)"(?:[^"\\]|\\.)*"/${1}"[REDACTED]"/g;
		#     `constant_value` COLLAPSES the wrapper rather than redacting inside it. The tripwire
		#     classifies a value by its first 24 characters, and `{"constant_value":"` is 19 of them
		#     — leaving `[REDA`, so its "already redacted?" filter could not see our marker and the
		#     shape stayed flagged even once scrubbed. Emitting `"key":"[REDACTED]"` puts the marker
		#     inside the window. Verify with the round-trip assertion below if that window moves.
		s/(["][\w.\-]*$den[\w.\-]*["]\s*:\s*)\{\s*["]constant_value["]\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/${1}"[REDACTED]"/g;
		#     Array-valued, bare and inside the `{"value":…}` wrapper. The elements have no key of
		#     their own, so the denylisted key is the only cover they get.
		#     `${1}` is NOT optional: `$1[` interpolates as an ARRAY SUBSCRIPT, so the replacement
		#     silently became empty and the rule DELETED the whole array instead of redacting it.
		s/(["][\w.\-]*$den[\w.\-]*["]\s*:\s*\{\s*["]value["]\s*:\s*)\[[^\]]*"[^\]]*\]/${1}["[REDACTED]"]/g;
		s/(["][\w.\-]*$den[\w.\-]*["]\s*:\s*)\[[^\]]*"[^\]]*\]/${1}["[REDACTED]"]/g;
		s/(["][\w.\-]*$den[\w.\-]*["]\s*:\s*)"(?:[^"\\]|\\.)*"/$1"[REDACTED]"/g;
		# (4b) DECLARATION shapes (#1954). The `configuration` section of a plan JSON DESCRIBES every
		#      variable and module, so a denylisted NAME shows up there wrapped in a schema block
		#      instead of carrying a value: `"admin_password":{"default":"…","description":…}`.
		#      Nothing above matches that wrapper, so a genuinely hardcoded default was flagged by
		#      the tripwire and unredactable here — a permanently red leg.
		#      The denylist is the TERMINAL one, and the default must be a NON-EMPTY string (or an
		#      array holding one): `"admin_password":{"default":""}` carries nothing, and
		#      `"auth_token_update_strategy":{"default":"ROTATE"}` is an enum, not a credential.
		#      Redact IN PLACE rather than collapsing the wrapper the way `constant_value` does — a
		#      variable block continues past its default (`,"description":…`), so collapsing it
		#      would unbalance the JSON. `{"default":"` is 12 characters, which keeps the marker
		#      inside the 24-character window the tripwire classifies a value by.
		s/(["][\w.\-]*$dent["]\s*:\s*\{\s*["]default["]\s*:\s*)"(?:[^"\\]|\\.)+"/${1}"[REDACTED]"/g;
		s/(["][\w.\-]*$dent["]\s*:\s*\{\s*["]default["]\s*:\s*)\[[^\]]*"[^\]]*\]/${1}["[REDACTED]"]/g;
		# (4c) Credentials inside a module `source` URL — `git::https://user:TOKEN@host/repo` is a
		#      documented Terraform source form. Key-agnostic, because the module NAME carries no
		#      signal here; the URL does. Only the userinfo dies, so the artifact still shows which
		#      module resolved from which host — that evidence is the point of uploading it at all.
		s/(["]source["]\s*:\s*"[^"]*:\/\/)[^"\/@]+:[^"\/@]+@/${1}\[REDACTED\]@/g;
		# (5) BARE key mid-line: logfmt `hcloud_token=abc` inside a longer line. The lookbehind
		#     keeps it off quoted JSON keys (rule 4 territory — a JSON key sits behind a `"`), and
		#     the lookaheads leave structural values alone: a `{` or `[` opener, a JSON literal,
		#     the tofu placeholders, and our own marker. Those carry no secret, and redacting them
		#     would corrupt the plan JSON for no gain.
		s/(?<!["\w.\-])([\w.\-]*$den[\w.\-]*\s*[:=]\s*)"(?:[^"\\]|\\.)*"/$1"[REDACTED]"/g;
		s/(?<!["\w.\-])([\w.\-]*$den[\w.\-]*\s*[:=]\s*)(?!["\{\[])(?!true\b)(?!false\b)(?!null\b)(?!\((?:sensitive value|sensitive|known after apply)\))(?!\[REDACTED)([^\s,}\]]+)/$1\[REDACTED\]/g;
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
# ── The verdict this function reaches is UNCHANGED by #2157. What it now also records is WHY, so
#    a caller can tell an unambiguous secret apart from a heuristic shape match:
#
#      SCRUB_HARD_FAIL=1        checks (1)/(2) — an exact known secret literal, or a PEM private
#                               key. No interpretation involved: the value IS the credential.
#      SCRUB_HEURISTIC_HITS     checks (3)/(3b)/(4) — a denylisted KEY appearing to carry a
#                               plaintext value. These are shape matchers over log text, and the
#                               shapes they cannot classify are open-ended by construction.
#
#    The split exists because the two deserve different remedies, not because one is unimportant.
#    See scrub-runner-log.sh: a hard fail still refuses to publish anything; a heuristic hit gets
#    its LINE elided and the rest of the log survives. Nothing here is relaxed to make that work —
#    the regexes, the exclusions and the return code are byte-for-byte the same, because widening
#    any of them re-opens #2070 (the fail-OPEN tripwire, where one `[REDACTED]` on a line
#    suppressed every other finding on it).
assert_grep_clean() {
	local dir="$1" rc=0 lit hits
	SCRUB_HARD_FAIL=0
	SCRUB_HEURISTIC_HITS=""
	# 1) Exact secret literals must not appear at all.
	while IFS= read -r lit; do
		[ -z "$lit" ] && continue
		if grep -rIqF -- "$lit" "$dir" 2>/dev/null; then
			echo "::error::proof-scrub: a secret LITERAL value survived into the proof bundle ($dir)" >&2
			SCRUB_HARD_FAIL=1
			rc=1
		fi
	done <<<"${SCRUB_LITERALS:-}"
	# 2) No PEM private keys.
	if grep -rIqE -- '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----' "$dir" 2>/dev/null; then
		echo "::error::proof-scrub: a PEM PRIVATE KEY survived into the proof bundle ($dir)" >&2
		SCRUB_HARD_FAIL=1
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
	#      c) the value is an object whose FIRST key is `default` or `source` — a variable or
	#         module DECLARATION. A plan JSON's `configuration` section describes the schema, so a
	#         denylisted NAME appears there wrapped in a block that carries no value of its own:
	#         `"admin_password":{"default":"","description":…}` is the variable being declared,
	#         not a password. On its own this exclusion is a HOLE in both directions — a default
	#         genuinely can hold a hardcoded secret, and a module source genuinely can carry
	#         `git::https://user:TOKEN@host/repo`. It is safe ONLY because check (3b) below
	#         positively re-flags exactly those two sub-shapes. Never widen one without the other.
	#
	#      d) the value is an object whose FIRST key is `type` — a variable's TYPE CONSTRAINT, and
	#         the shape that cost the first real hetzner run its ledger row (#2062). A plan JSON's
	#         `configuration.root_module.variables` section declares every root variable as
	#         `"hcloud_token":{"type":"string","description":…}`. The captured 24-character window
	#         stops at `{"type":"string"` — before any value — so the `REDACTED` filter above never
	#         sees the marker that was in fact already there, and three correctly-scrubbed hetzner
	#         credentials plus a DURATION (`admin_kubeconfig_cert_lifetime`) were reported as
	#         plaintext. A type constraint is a string or an array of strings and can hold no
	#         value, so it is metadata by construction, exactly like (b) and (c).
	#
	#      e) the value is an object whose FIRST key is `actions` and whose array holds only
	#         OpenTofu's own change verbs — `"kubeconfig":{"actions":["create"]…`, the
	#         `resource_changes[].change` shape. Anchored to the verb vocabulary rather than to
	#         "any array", because an unanchored `actions` exclusion would swallow
	#         `{"actions":["<secret>"]}` on its way past.
	#
	#    (d) and (e) are safe for the same reason (c) is: 3b below positively re-flags a hardcoded
	#    `default`, so a variable that declares BOTH a type and a secret default is still caught.
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
		grep -vE '[:=][[:space:]]*\{["]?(sensitive|references|expression)["]?[[:space:]]*:[[:space:]]*(true|false|null|\[|\{)' |
		grep -vE '[:=][[:space:]]*\{["]?(default|source)["]?[[:space:]]*:' |
		grep -vE '[:=][[:space:]]*\{["]?type["]?[[:space:]]*:[[:space:]]*(["]|\[)' |
		grep -vE '[:=][[:space:]]*\{["]?actions["]?[[:space:]]*:[[:space:]]*\[[[:space:]]*["](create|read|update|delete|no-op)["]' || true)"
	if [ -n "$hits" ]; then
		echo "::error::proof-scrub: a denylisted key still carries a plaintext value in the proof bundle ($dir):" >&2
		# Print the KEY only. This used to print the whole matching line, which meant the tripwire
		# pasted the surviving secret into the CI log — republishing the leak into the very place
		# the scrub exists to keep clean. Found while testing the #1854 fail-closed path against a
		# deliberately weakened scrub.
		printf '%s\n' "$hits" | sed -E 's/[[:space:]]*[:=][[:space:]]*.*$/ = [value withheld]/' | sort -u | head -5 >&2
		SCRUB_HEURISTIC_HITS="${SCRUB_HEURISTIC_HITS}${hits}"$'\n'
		rc=1
	fi
	# 3b) The two sub-shapes exclusion (c) just dropped that CAN still carry a secret. Dropping a
	#     declaration wrapper wholesale is the hole #1954 refused to open, so each is positively
	#     re-flagged — narrowly, and by CONSTRUCTION rather than by naming survivors.
	#
	#     (a) a hardcoded secret DEFAULT. The denylist token must be TERMINAL in the variable name
	#         — nothing may follow it before the closing quote — which is what makes the aws
	#         runner log's three survivors fall out on their own shape: `admin_password` ends in
	#         `password` and stays caught, `auth_token_update_strategy` ends in `strategy`,
	#         `custom_secrets_password_module` ends in `module`. An EMPTY default carries nothing,
	#         so the default must be a non-empty string, or an array holding one (the array form is
	#         not decoration: without it, `"password_list":{"default":["…"]}` would be excluded by
	#         (c) and re-flagged by nothing).
	hits="$(grep -rIhoE -- '"[A-Za-z0-9_.-]*(client[_-]?key|client-key-data|private[_-]?key|talosconfig|kubeconfig|kube_config|password|secret[_-]?value|secret[_-]?key|access[_-]?key|[_-]token)"[[:space:]]*:[[:space:]]*\{[[:space:]]*"default"[[:space:]]*:[[:space:]]*("[^"]+"|\[[^]]*"[^]]*\])' "$dir" 2>/dev/null | grep -v 'REDACTED' || true)"
	if [ -n "$hits" ]; then
		echo "::error::proof-scrub: a variable declaration carries a hardcoded secret default ($dir):" >&2
		# The KEY only, never the value — see the note on check (3).
		printf '%s\n' "$hits" | sed -E 's/"[[:space:]]*:.*$/" = [default withheld]/' | sort -u | head -5 >&2
		SCRUB_HEURISTIC_HITS="${SCRUB_HEURISTIC_HITS}${hits}"$'\n'
		rc=1
	fi
	#     (b) credentials in a module `source`. Key-agnostic on purpose: `git::https://user:TOKEN@
	#         host/repo` is a documented Terraform source form and it is a leak whatever the module
	#         is called, so the module NAME carries no signal here — the URL does.
	hits="$(grep -rIhoE -- '"source"[[:space:]]*:[[:space:]]*"[^"]*://[^"/@]+:[^"/@]+@' "$dir" 2>/dev/null | grep -v 'REDACTED' || true)"
	if [ -n "$hits" ]; then
		echo "::error::proof-scrub: a module source URL carries credentials ($dir):" >&2
		# Here the userinfo IS the secret, so there is no key that can be named safely: keep the
		# scheme (which tells the operator what kind of source it was) and withhold the rest.
		printf '%s\n' "$hits" | sed -E 's|(://).*|\1[credentials withheld]|' | sort -u | head -5 >&2
		SCRUB_HEURISTIC_HITS="${SCRUB_HEURISTIC_HITS}${hits}"$'\n'
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
		SCRUB_HEURISTIC_HITS="${SCRUB_HEURISTIC_HITS}${hits}"$'\n'
		rc=1
	fi
	return "$rc"
}

# ── scrub_elide_heuristic_lines <file> — replace every LINE of <file> that carries a surviving
#    heuristic hit with a marker, leaving the rest of the file intact (#2157).
#
#    Call ONLY after assert_grep_clean has run and ONLY when SCRUB_HARD_FAIL is 0. It consumes
#    that function's recorded matches rather than re-deriving them, so there is exactly one
#    definition of "what counts as a hit" — a second copy of that regex chain is precisely the
#    drift this repo keeps paying for, and here it would drift in the direction of publishing.
#
#    Why elide rather than refuse: refusing destroyed the evidence for exactly the legs that got
#    FURTHEST. aws and gcp reached `applying` and uploaded no runner log at all, while azure died
#    at `planning` and kept its. The further a run gets, the more log it emits, the more likely
#    some unclassifiable shape appears — so the failure mode was inverted, and #2098/#2099 were
#    undiagnosable as a direct result. Eliding the offending LINE keeps that trade honest: the
#    line that could not be classified is gone in full, and every other line survives.
#
#    The marker names the KEY only — never the value — for the same reason the tripwire's own
#    message does: printing it would republish the leak into the artifact this exists to protect.
scrub_elide_heuristic_lines() {
	local file="$1" keys
	[ -f "$file" ] || return 0
	[ -n "${SCRUB_HEURISTIC_HITS:-}" ] || return 0
	# The recorded hits are `-o` match text: each is a substring that appears verbatim on some
	# line of the file. Fixed-string matching (never regex) is what keeps this exact — a hit can
	# contain any character at all, and interpreting it would both miss lines and match wrong ones.
	local tmp
	tmp="$(mktemp)"
	printf '%s\n' "$SCRUB_HEURISTIC_HITS" | grep -v '^$' | sort -u >"$tmp"
	keys="$(sed -E 's/[[:space:]]*[:=].*$//' "$tmp" | tr -d '"' | sort -u | tr '\n' ' ')"
	# grep -vFf removes every line containing any recorded hit; the count difference is what we
	# report. Two passes rather than one so the operator is told how much was dropped.
	local before after
	before="$(wc -l <"$file" | tr -d ' ')"
	grep -vFf "$tmp" "$file" >"${file}.elided" 2>/dev/null || cp "$file" "${file}.elided"
	after="$(wc -l <"${file}.elided" | tr -d ' ')"
	{
		echo ""
		echo "[$((before - after)) LINE(S) ELIDED BY THE PROOF-SCRUB TRIPWIRE]"
		echo "[  a denylisted key appeared to carry a plaintext value the scrub could not redact]"
		echo "[  key(s): ${keys}]"
		echo "[  the whole line was removed; the value is not reproduced anywhere in this file]"
		echo "[  see demos/proofs/scrub.sh check (3)/(3b)/(4) and issue #2157]"
	} >>"${file}.elided"
	mv "${file}.elided" "$file"
	echo "  elided $((before - after)) line(s) carrying unclassifiable denylisted key(s): ${keys}" >&2
	rm -f "$tmp"
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
{"configuration":{"root_module":{"resources":[{"expressions":{"admin_password":{"constant_value":"$fake_planjson"}}}]}},"registry_tokens":["$fake_planjson"],"rotation_tokens":{"value":["$fake_planjson"]},"region":{"value":"KEEP-ME-ARRAYLINE-REGION"}}
time=2026-08-04T06:12:12Z level=error msg="apply failed" hcloud_token=$fake_planjson step=KEEP-ME-LOGFMT-STEP
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
	# Same, for the array/constant_value line and the logfmt line: redact the value, keep the line.
	local marker
	for marker in KEEP-ME-ARRAYLINE-REGION KEEP-ME-LOGFMT-STEP; do
		grep -qF "$marker" "$scrubbed" && continue
		echo "SELF-TEST FAIL: a scrub rule ate the non-secret remainder of its line ($marker)" >&2
		return 1
	done
	# The scrubbed bundle must pass the tripwire. This is the assertion that keeps the scrub and
	# the tripwire in step: assert_grep_clean flags a denylisted key carrying any non-structural
	# value, so EVERY shape it flags must be one scrub_stream can redact. When they drifted apart
	# — `{"constant_value":"…"}`, `["…"]`, `{"value":["…"]}` and logfmt `key=value` were flagged
	# but unredactable — the affected leg could never produce a bundle at all. Adding a shape to
	# the tripwire without adding it here is what that regression looks like.
	if ! assert_grep_clean "$work/out"; then
		echo "SELF-TEST FAIL: assert_grep_clean flagged a correctly-scrubbed bundle" >&2
		echo "  If a NEW shape was added to the tripwire, scrub_stream has to be able to redact it," >&2
		echo "  or the leg carrying that shape is red forever." >&2
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
	# ── #2062: a variable TYPE CONSTRAINT and a resource-change ACTION LIST are metadata too. ──
	# This is the fixture the first real hetzner run died on. Its credentials were ALREADY scrubbed
	# to `[REDACTED]`; what the tripwire matched was the plan JSON's declaration of the same names,
	# whose 24-character window ends at `{"type":"string"` — before the marker that would have
	# cleared it. The run lost its ledger row to a bundle that was clean.
	local meta_decl="$work/meta-decl"
	mkdir -p "$meta_decl"
	cat >"$meta_decl/plan.json" <<'EOF'
{"configuration":{"root_module":{"variables":{"hcloud_token":{"type":"string","description":"…"},"hetzner_s3_access_key":{"type":"string"},"hetzner_s3_secret_key":{"type":"string"},"admin_kubeconfig_cert_lifetime":{"type":"string"},"password_list":{"type":["list","string"]}}}},"resource_changes":[{"change":{"kubeconfig":{"actions":["create"]},"talosconfig":{"actions":["create"]},"client_key":{"actions":["delete","create"]}}}],"variables":{"hcloud_token":{"value":"[REDACTED]"},"hetzner_s3_secret_key":{"value":"[REDACTED]"}}}
EOF
	if ! assert_grep_clean "$meta_decl" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: assert_grep_clean flagged variable type constraints / change actions (over-broad — this is #2062)" >&2
		return 1
	fi
	# …and the narrowing must not have opened a hole: a variable that declares a type AND carries a
	# hardcoded secret default is still a leak, and 3b is what has to catch it.
	local meta_decl_bad="$work/meta-decl-bad"
	mkdir -p "$meta_decl_bad"
	cat >"$meta_decl_bad/plan.json" <<'EOF'
{"variables":{"admin_password":{"default":"planjson-FAKE-PLACEHOLDER-typed-default-DO-NOT-LEAK"}}}
EOF
	if assert_grep_clean "$meta_decl_bad" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: the #2062 narrowing swallowed a hardcoded secret default" >&2
		return 1
	fi
	# An `actions` array that is NOT a tofu change verb is not metadata — it is an array whose
	# contents were never vetted, and the exclusion must not reach it.
	rm -f "$meta_decl_bad/plan.json"
	cat >"$meta_decl_bad/smuggled.json" <<'EOF'
{"hcloud_token":{"actions":["planjson-FAKE-PLACEHOLDER-smuggled-in-an-array-DO-NOT-LEAK"]}}
EOF
	if assert_grep_clean "$meta_decl_bad" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: the #2062 actions exclusion accepted a non-verb array (too wide)" >&2
		return 1
	fi
	rm -f "$meta_decl_bad/smuggled.json"

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

	# ── DECLARATION shapes: `{"default":…}` and `{"source":…}` (#1954). ──
	# The aws runner log — the ONE cloud whose T2 real apply actually runs — was refused by the
	# tripwire on three keys that were every one of them a variable or module DECLARATION:
	# `admin_password` (an EMPTY default), `auth_token_update_strategy` and
	# `custom_secrets_password_module`. Exclusion (c) drops the wrapper; checks (3b)(a) and (3b)(b)
	# re-flag the two sub-shapes inside it that can genuinely carry a secret. Pin the WHOLE truth
	# table in both directions — and, for the shapes that must trip, that scrub_stream can actually
	# redact them, because a flagged-but-unredactable shape is a leg red forever (twice now).
	local decl="$work/decl" row expect keep body
	mkdir -p "$decl"
	for row in \
		'PASS|"default":""|{"variables":{"admin_password":{"default":"","description":"an empty default is not a password"}}}' \
		'FAIL||{"variables":{"admin_password":{"default":"planjson-FAKE-PLACEHOLDER-hardcoded-default-DO-NOT-LEAK","description":"terminal name, real default"}}}' \
		'PASS|ROTATE-KEEP-ME-DECL|{"variables":{"auth_token_update_strategy":{"default":"ROTATE-KEEP-ME-DECL"}}}' \
		'PASS|./modules/awssm-passgen-KEEP-ME-DECL|{"module_calls":{"custom_secrets_password_module":{"source":"./modules/awssm-passgen-KEEP-ME-DECL"}}}' \
		'FAIL||{"module_calls":{"custom_secrets_password_module":{"source":"git::https://u:planjson-FAKE-PLACEHOLDER-src-DO-NOT-LEAK@example.invalid/r"}}}'; do
		IFS='|' read -r expect keep body <<<"$row"
		rm -f "$decl"/*
		printf '%s\n' "$body" >"$decl/plan.json"
		if assert_grep_clean "$decl" >/dev/null 2>&1; then
			if [ "$expect" != PASS ]; then
				echo "SELF-TEST FAIL: the tripwire PASSED a declaration that carries a secret: ${body:0:56}…" >&2
				return 1
			fi
		else
			if [ "$expect" != FAIL ]; then
				echo "SELF-TEST FAIL: the tripwire FLAGGED a clean declaration — this is #1954: ${body:0:56}…" >&2
				return 1
			fi
		fi
		# Whichever way it went, the scrubbed form must be clean, the seeded secret must be gone,
		# and the non-secret part of the declaration must survive — an artifact scrubbed down to
		# `[REDACTED]` everywhere is no more useful than one that was never uploaded.
		scrub_stream <"$decl/plan.json" >"$decl/scrubbed.json"
		rm -f "$decl/plan.json"
		if ! assert_grep_clean "$decl" >/dev/null 2>&1; then
			echo "SELF-TEST FAIL: scrub_stream cannot redact a shape the tripwire flags: ${body:0:56}…" >&2
			return 1
		fi
		if grep -qF 'DO-NOT-LEAK' "$decl/scrubbed.json"; then
			echo "SELF-TEST FAIL: a seeded declaration secret survived scrub_stream: ${body:0:56}…" >&2
			return 1
		fi
		if [ -n "$keep" ] && ! grep -qF -- "$keep" "$decl/scrubbed.json"; then
			echo "SELF-TEST FAIL: scrub_stream over-redacted a non-secret declaration ($keep)" >&2
			return 1
		fi
	done
	rm -rf "$decl"

	# ── The HARVEST, not just the redaction (#1875). ──
	# Everything above builds SCRUB_LITERALS by hand, so it proves scrub_stream redacts what it is
	# GIVEN and says nothing about whether the run's actual credentials get into that list. That is
	# the #1854 gap exactly: the scrub worked, the list was short. So drive the real harvester and
	# assert every credential a leg can hold comes out the other side.
	local saved_literals="${SCRUB_LITERALS:-}" name missed=""
	local -a cred_vars=(
		HCLOUD_TOKEN E2E_GIT_TOKEN ALETHIA_E2E_GIT_TOKEN
		# Hetzner Object Storage: a SECOND hetzner credential pair, unrelated to HCLOUD_TOKEN and
		# not derivable from it, that a full-bar leg holds so the `bucket` kind can be proven. Both
		# halves are listed — an S3 access key is a credential, not an identifier, and covering one
		# half is the #1854 shape in miniature.
		HETZNER_S3_ACCESS_KEY HETZNER_S3_SECRET_KEY
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

	# ── ELISION: a refused log still yields an artifact (#2157). ──
	# The property under test is that the further-a-run-gets-the-less-survives inversion is gone:
	# a heuristic hit must cost the OFFENDING LINE and nothing else. Every step below asserts its
	# own precondition before the thing it is testing, because this is an absence-assertion and an
	# absence-assertion whose setup planted nothing passes while the bug is still there.
	local el="$work/elide"
	mkdir -p "$el"
	# A shape the tripwire flags and scrub_stream does NOT know how to redact — a bare logfmt-ish
	# key whose value is JSON-ish enough to dodge the redactor but not the detector. Alongside it,
	# a line of ordinary diagnostic text: that line is the evidence the elision exists to keep.
	cat >"$el/t2-runner.log" <<'EOF'
2026-08-10T04:52:01Z applying module.eks.aws_eks_cluster.this
ELIDE-KEEP-ME-diagnostic-line-that-must-survive
{"unclassifiable_wrapper":{"admin_password":ELIDE-FAKE-UNREDACTABLE-DO-NOT-LEAK}}
2026-08-10T04:52:02Z apply complete
EOF
	SCRUB_LITERALS="" # exercise the HEURISTIC path only; a literal would be a hard fail by design
	# Precondition 1 — the tripwire must actually fire on this fixture. If it does not, everything
	# below is vacuous and the arm must fail rather than report success.
	if assert_grep_clean "$el" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: the elision fixture does not trip the tripwire — the arm would be vacuous" >&2
		return 1
	fi
	# Precondition 2 — it must be a HEURISTIC finding, not a hard fail, or we are testing the
	# wrong branch.
	if [ "${SCRUB_HARD_FAIL:-0}" = "1" ]; then
		echo "SELF-TEST FAIL: the elision fixture tripped the LITERAL/PEM path, not the heuristic one" >&2
		return 1
	fi
	scrub_elide_heuristic_lines "$el/t2-runner.log" 2>/dev/null
	# 1. The artifact still exists and is now clean — this is the whole point of #2157.
	if ! assert_grep_clean "$el" >/dev/null 2>&1; then
		echo "SELF-TEST FAIL: eliding the flagged lines did not satisfy the tripwire" >&2
		return 1
	fi
	# 2. The offending value is gone.
	if grep -qF 'ELIDE-FAKE-UNREDACTABLE-DO-NOT-LEAK' "$el/t2-runner.log"; then
		echo "SELF-TEST FAIL: the elided value survived into the artifact" >&2
		return 1
	fi
	# 3. …and the rest of the log survived. An artifact elided down to nothing is no more useful
	#    than one that was never uploaded — the same property the declaration arm pins above.
	if ! grep -qF 'ELIDE-KEEP-ME-diagnostic-line-that-must-survive' "$el/t2-runner.log"; then
		echo "SELF-TEST FAIL: elision removed non-offending lines — this re-creates #2157" >&2
		return 1
	fi
	if ! grep -qF 'apply complete' "$el/t2-runner.log"; then
		echo "SELF-TEST FAIL: elision truncated the log after the offending line" >&2
		return 1
	fi
	# 4. The operator is told what was dropped, by key, and never by value.
	if ! grep -q 'ELIDED BY THE PROOF-SCRUB TRIPWIRE' "$el/t2-runner.log"; then
		echo "SELF-TEST FAIL: elision left no marker saying lines were removed" >&2
		return 1
	fi
	SCRUB_LITERALS="$saved_literals"
	export SCRUB_LITERALS
	rm -rf "$el"

	echo "scrub self-test OK: seeded secrets redacted, sentinel kept, tripwire non-vacuous, elision keeps the log, ${#cred_vars[@]} credentials harvested"
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
