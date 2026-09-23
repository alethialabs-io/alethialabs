#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# keyless-db-e2e.sh <cloud> <engine> — run ONE keyless-database e2e and PERSIST it (#1511 / #1513).
#
# The "every run is recorded" engine for the keyless parity board, mirroring secrets-e2e.sh: it runs
# the env-gated T2 scenario, captures a scrubbed proof bundle, appends the append-only ledger, and on
# FAILURE files (or updates) a title-deduped GitHub issue — so the history accumulates and a bad
# night is never merely forgotten.
#
#   cloud  : aws | gcp | azure          (alibaba/hetzner are documented exclusions, never runs)
#   engine : postgres | mysql
#
#   keyless-db-e2e.sh --self-test       # run the offline cases; no cloud, no network, no repo write
#
# The keyless epic has had no ledger at all, which is why a path that had never authenticated to a
# real database could look shipped for months (#1500). An empty ledger is a legible answer; a green
# board with no runs behind it is not.
#
# A SKIPPED test is classified BLOCKED, never PASS. That is the mistake that let four clouds'
# green-skips read as proofs on the provisioning board (#1723) — and see keyless_classify_verdict,
# which is where this script had made that exact mistake itself.
#
# The caller exports the target env (see docs/testing/e2e-nightly-enablement.md):
#   ALETHIA_E2E_KEYLESS_DB=1 ALETHIA_E2E_KEYLESS_DB_{ENGINE,NAME,NAMESPACE,SERVICE,IMAGE,...}
#   plus the provider creds the base T2 proof needs.
#
# Env knobs: NO_ISSUE=1 (don't file a GH issue on fail) · BLOCKED="<reason>" (force a BLOCKED record).
set -uo pipefail

# ══════════════════════════════════════════════════════════════════════════════════════════════
# PURE HELPERS — no cloud, no network, no repo state. Everything `--self-test` exercises lives
# here, and nothing here writes to a path it was not handed. The verdict classifier in particular
# is the whole safety property of this script, so it is a function that can be called with
# fixtures rather than a branch buried in the run path.
# ══════════════════════════════════════════════════════════════════════════════════════════════

# The exclusion prose, quoted from manifests.KeylessCell — the same table the canvas shows on the
# disabled toggle and docs/testing/keyless-db-parity.md carries in full. Kept as constants so the
# gate and the operator message cannot drift apart.
keyless_alibaba_exclusion="alibaba is a documented EXCLUSION, not a lane: RAM governs ApsaraDB's control plane only — there is no data-plane token login."
keyless_hetzner_exclusion="hetzner is a documented EXCLUSION, not a lane: Postgres runs in-cluster via CloudNativePG, with no managed instance and no cloud identity plane."

# keyless_cell_lane <cloud> — is this cloud a lane we RUN, a product EXCLUSION, or nonsense?
#
# Refusing an excluded cell matters more than it looks: recording a FAIL against alibaba or hetzner
# would put a red row on the board against a boundary that is working exactly as designed.
keyless_cell_lane() {
	case "${1:-}" in
	aws | gcp | azure) printf 'run\n' ;;
	alibaba | hetzner) printf 'excluded\n' ;;
	*) printf 'unknown\n' ;;
	esac
}

# keyless_exclusion_reason <cloud> — the product-voice why, for an excluded cloud.
keyless_exclusion_reason() {
	case "${1:-}" in
	alibaba) printf '%s\n' "$keyless_alibaba_exclusion" ;;
	hetzner) printf '%s\n' "$keyless_hetzner_exclusion" ;;
	*) printf '\n' ;;
	esac
}

# keyless_summary_verdict <summary.json> — the scenario's OWN verdict, or "" when it wrote nothing.
#
# Deliberately a `sed` over the file rather than a JSON parser: this must work on a maintainer's
# laptop mid-incident with nothing installed, and the field is written by keylessSummaryJSON with
# a fixed shape (encoding/json, two-space indent).
keyless_summary_verdict() {
	keyless_summary_field "${1:-}" verdict
}

# keyless_summary_field <summary.json> <field> — one top-level string field, or "" when absent.
keyless_summary_field() {
	local f="${1:-}" field="${2:-}"
	[[ -n "$f" && -f "$f" && -n "$field" ]] || return 0
	sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$f" | head -n 1
}

# keyless_summary_mismatch <summary.json> <cloud> <engine> — prints what the summary measured when it
# is NOT the cell the caller asked for, or nothing when it matches (or says nothing).
#
# The test picks its cloud from ALETHIA_E2E_PROVIDER, not from this script's argument. A value left
# over in the shell from an earlier run would otherwise let `keyless-db-e2e.sh aws postgres` record a
# gcp PASS as an aws PASS — the run path sets the variable itself now, and this is the check that the
# summary agrees rather than the assumption that it must.
keyless_summary_mismatch() {
	local f="${1:-}" cloud="${2:-}" engine="${3:-}" got_p got_e
	got_p="$(keyless_summary_field "$f" provider)"
	got_e="$(keyless_summary_field "$f" engine)"
	if [[ -n "$got_p" && "$got_p" != "$cloud" ]] || [[ -n "$got_e" && "$got_e" != "$engine" ]]; then
		printf '%s/%s\n' "${got_p:-?}" "${got_e:-?}"
	fi
}

# keyless_classify_verdict <rc> <log> <summary.json> [cloud engine] — the run's verdict: PASS | FAIL | BLOCKED.
#
# THE SUMMARY FILE IS THE AUTHORITY, not `go test`'s own exit line. test/e2e/t2_provision_test.go
# calls runT2KeylessDB only under `if keylessOn`, and that function writes the summary from a
# `defer` with Verdict pre-set to "FAIL" — so the file exists if and only if the keyless stage
# actually ran, and when it exists it already carries that stage's verdict.
#
# The first cut of this script got that wrong, in the one direction that MANUFACTURES a proof. It
# asked `rc == 0 && grep -q '^ok\|^--- PASS\|^PASS'` FIRST. A Go test that SKIPS prints both of
# those markers and exits 0 — measured, not assumed:
#
#     --- SKIP: TestSkippy (0.00s)
#     PASS
#     ok  	probe	0.447s          rc=0
#
# so the skip branch below it was unreachable, and an un-configured run — overwhelmingly the most
# likely FIRST run — recorded **PASS**. demos/proofs/keyless-db-e2e-log.md says a cell goes ✅ only
# when a PASS row names the run that proved it, so that row was one step from flipping a parity
# cell green with nothing behind it. #1723 exactly, inside the script whose header promises to
# prevent it.
#
# The rule is now: a verdict is PASS only when the stage itself said PASS. Everything else is
# BLOCKED (the stage never ran) or FAIL (it ran and did not pass, or the run around it broke).
keyless_classify_verdict() {
	local rc="${1:-1}" log="${2:-}" summary="${3:-}" cloud="${4:-}" engine="${5:-}" scenario
	scenario="$(keyless_summary_verdict "$summary")"

	# A summary for a DIFFERENT cell proves nothing about this one, whatever its verdict: this cell's
	# stage did not run. BLOCKED, never PASS (and not FAIL — the other cell may be perfectly fine).
	if [[ -n "$cloud" && -n "$(keyless_summary_mismatch "$summary" "$cloud" "$engine")" ]]; then
		printf 'BLOCKED\n'
		return 0
	fi

	if [[ -n "$scenario" ]]; then
		# The stage ran and reported. A non-zero rc can only DOWNGRADE that verdict, never
		# upgrade it: a failure elsewhere in T2 still invalidates the run the proof sits in.
		if [[ "$scenario" == "PASS" && "$rc" -eq 0 ]]; then printf 'PASS\n'; else printf 'FAIL\n'; fi
		return 0
	fi

	# No summary ⇒ the keyless stage never ran, whatever the surrounding test reported. That is
	# BLOCKED and never PASS — including the case the old code could not see at all, where the
	# outer T2 test passes on its own merits while keyless was simply switched off.
	if [[ "$rc" -ne 0 ]] || grep -q 'FAIL' "$log" 2>/dev/null; then
		printf 'FAIL\n'
	else
		printf 'BLOCKED\n'
	fi
}

# keyless_ledger_row <date> <cloud> <engine> <verdict> <sha> <detail> <bundle> — one Markdown row.
#
# `detail` is free text lifted from a log, so it is scrubbed of the two characters that would
# corrupt the table: a `|` splits the row into phantom columns, a newline ends it early. Both are
# neutralized HERE rather than at each call site, which is how one of them got missed before.
keyless_ledger_row() {
	local date="${1:-}" cloud="${2:-}" engine="${3:-}" verdict="${4:-}" sha="${5:-}" detail="${6:-}" bundle="${7:-}"
	detail="${detail//|/;}"
	detail="${detail//$'\n'/ }"
	# shellcheck disable=SC2016  # the backticks are LITERAL Markdown code spans, not expansions
	printf '| %s | %s | %s | **%s** | `%s` | %s `%s` |\n' \
		"$date" "$cloud" "$engine" "$verdict" "$sha" "$detail" "$bundle"
}

# ══════════════════════════════════════════════════════════════════════════════════════════════
# SELF-TEST — offline. Must run BEFORE the positional-argument checks below, since it takes none.
# ══════════════════════════════════════════════════════════════════════════════════════════════
if [[ "${1:-}" == "--self-test" ]]; then
	fails=0
	# NOTE: _t runs in THIS shell on purpose. `fails=$((fails+1))` inside a subshell — a pipeline,
	# a `$(…)`, a `( … )` — increments a copy that dies with it, so the report reads FAIL and the
	# run still exits 0. The exit code is the test; the printed text is only a report.
	_t() { # _t <name> <got> <want>
		if [[ "$2" == "$3" ]]; then
			echo "  ✓ $1"
		else
			echo "  ✗ $1 — expected '$3', got '$2'" >&2
			fails=$((fails + 1))
		fi
	}
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	echo "keyless-db-e2e --self-test"

	# ── the cell gate ────────────────────────────────────────────────────────────────────────
	for c in aws gcp azure; do _t "lane($c) runs" "$(keyless_cell_lane "$c")" "run"; done
	for c in alibaba hetzner; do _t "lane($c) excluded" "$(keyless_cell_lane "$c")" "excluded"; done
	_t "lane(nonsense) unknown" "$(keyless_cell_lane "wat")" "unknown"
	_t "lane(empty) unknown" "$(keyless_cell_lane "")" "unknown"
	_t "alibaba reason is the product's" \
		"$(keyless_exclusion_reason alibaba)" "$keyless_alibaba_exclusion"

	# ── the summary reader ───────────────────────────────────────────────────────────────────
	printf '{\n  "feature": "keyless-db-auth",\n  "verdict": "PASS"\n}\n' >"$tmp/pass.json"
	printf '{\n  "feature": "keyless-db-auth",\n  "verdict": "FAIL",\n  "detail": "probe returned no rows"\n}\n' >"$tmp/fail.json"
	printf '{\n  "feature": "keyless-db-auth"\n}\n' >"$tmp/noverdict.json"
	printf '{\n  "feature": "keyless-db-auth",\n  "provider": "gcp",\n  "engine": "postgres",\n  "verdict": "PASS"\n}\n' >"$tmp/gcp-pass.json"
	_t "summary verdict PASS parses" "$(keyless_summary_verdict "$tmp/pass.json")" "PASS"
	_t "summary verdict FAIL parses" "$(keyless_summary_verdict "$tmp/fail.json")" "FAIL"
	_t "summary with no verdict field reads empty" "$(keyless_summary_verdict "$tmp/noverdict.json")" ""
	_t "absent summary reads empty" "$(keyless_summary_verdict "$tmp/nope.json")" ""
	_t "empty path reads empty" "$(keyless_summary_verdict "")" ""

	# ── the classifier. THE REGRESSION CASE FIRST. ───────────────────────────────────────────
	# Byte-for-byte what `go test -v` prints when the scenario's env gate is unset. The old
	# classifier returned PASS here; a PASS row is what flips a parity cell to ✅.
	cat >"$tmp/skip.log" <<-'LOG'
		=== RUN   TestT2RealCloudProvisioning
		    t2_provision_test.go:120: ALETHIA_E2E_T2 not set
		--- SKIP: TestT2RealCloudProvisioning (0.00s)
		PASS
		ok  	github.com/alethialabs-io/alethialabs/test/e2e	0.447s
	LOG
	_t "a SKIPPED run is BLOCKED, never PASS" \
		"$(keyless_classify_verdict 0 "$tmp/skip.log" "$tmp/absent.json")" "BLOCKED"

	# The other shape of the same hazard: `-run` matched nothing.
	cat >"$tmp/notests.log" <<-'LOG'
		testing: warning: no tests to run
		PASS
		ok  	github.com/alethialabs-io/alethialabs/test/e2e	0.301s [no tests to run]
	LOG
	_t "a 'no tests to run' run is BLOCKED" \
		"$(keyless_classify_verdict 0 "$tmp/notests.log" "$tmp/absent.json")" "BLOCKED"

	# The case no marker-grep could ever catch: the outer T2 test passes on its own merits while
	# the keyless stage was simply off, so the log carries no SKIP line at all.
	cat >"$tmp/ok-no-keyless.log" <<-'LOG'
		=== RUN   TestT2RealCloudProvisioning
		--- PASS: TestT2RealCloudProvisioning (912.44s)
		PASS
		ok  	github.com/alethialabs-io/alethialabs/test/e2e	912.981s
	LOG
	_t "a green T2 that never ran the keyless stage is BLOCKED" \
		"$(keyless_classify_verdict 0 "$tmp/ok-no-keyless.log" "$tmp/absent.json")" "BLOCKED"

	# The positive path — and the only route to PASS.
	_t "stage PASS + rc 0 is PASS" \
		"$(keyless_classify_verdict 0 "$tmp/ok-no-keyless.log" "$tmp/pass.json")" "PASS"
	# A stage that passed inside a run that did not: never a proof.
	_t "stage PASS + rc 1 is FAIL" \
		"$(keyless_classify_verdict 1 "$tmp/ok-no-keyless.log" "$tmp/pass.json")" "FAIL"
	_t "stage FAIL is FAIL" \
		"$(keyless_classify_verdict 1 "$tmp/ok-no-keyless.log" "$tmp/fail.json")" "FAIL"
	_t "stage FAIL is FAIL even at rc 0" \
		"$(keyless_classify_verdict 0 "$tmp/ok-no-keyless.log" "$tmp/fail.json")" "FAIL"
	# The summary must be for the cell asked for. A gcp PASS is not an aws PASS — the provider comes
	# from ALETHIA_E2E_PROVIDER, which a stale shell could have set to something else.
	_t "a PASS summary for another CLOUD is BLOCKED, not PASS" \
		"$(keyless_classify_verdict 0 "$tmp/ok-no-keyless.log" "$tmp/gcp-pass.json" aws postgres)" "BLOCKED"
	_t "a PASS summary for another ENGINE is BLOCKED, not PASS" \
		"$(keyless_classify_verdict 0 "$tmp/ok-no-keyless.log" "$tmp/gcp-pass.json" gcp mysql)" "BLOCKED"
	_t "a PASS summary for the SAME cell is PASS" \
		"$(keyless_classify_verdict 0 "$tmp/ok-no-keyless.log" "$tmp/gcp-pass.json" gcp postgres)" "PASS"
	_t "the mismatch names what was measured" \
		"$(keyless_summary_mismatch "$tmp/gcp-pass.json" aws postgres)" "gcp/postgres"
	_t "a matching summary reports no mismatch" \
		"$(keyless_summary_mismatch "$tmp/gcp-pass.json" gcp postgres)" ""
	# A summary that exists but carries no verdict is not a pass either.
	_t "summary without a verdict is BLOCKED (stage wrote nothing usable)" \
		"$(keyless_classify_verdict 0 "$tmp/ok-no-keyless.log" "$tmp/noverdict.json")" "BLOCKED"
	# A red run with no summary stays red rather than being laundered into BLOCKED.
	cat >"$tmp/fail.log" <<-'LOG'
		--- FAIL: TestT2RealCloudProvisioning (44.10s)
		FAIL	github.com/alethialabs-io/alethialabs/test/e2e	44.201s
	LOG
	_t "a red run with no summary is FAIL" \
		"$(keyless_classify_verdict 1 "$tmp/fail.log" "$tmp/absent.json")" "FAIL"
	_t "rc 0 but the log says FAIL is FAIL" \
		"$(keyless_classify_verdict 0 "$tmp/fail.log" "$tmp/absent.json")" "FAIL"

	# ── the ledger row ───────────────────────────────────────────────────────────────────────
	# The expected rows below are written out as LITERALS rather than built from the same format
	# string the function uses — a fixture derived from the code under test would stay green
	# through any change to that format, which is the one thing these assertions exist to catch.
	# shellcheck disable=SC2016  # literal Markdown code spans in the expected rows
	_t "row renders its columns" \
		"$(keyless_ledger_row 2026-09-20 aws postgres PASS abc1234 "query ok" demos/proofs/keyless/x)" \
		'| 2026-09-20 | aws | postgres | **PASS** | `abc1234` | query ok `demos/proofs/keyless/x` |'
	# A `|` from a log line would otherwise open two phantom columns in the table.
	# shellcheck disable=SC2016  # literal Markdown code spans in the expected row
	_t "a pipe in the detail cannot break the table" \
		"$(keyless_ledger_row 2026-09-20 aws mysql FAIL abc1234 'got a|b' demos/proofs/keyless/x)" \
		'| 2026-09-20 | aws | mysql | **FAIL** | `abc1234` | got a;b `demos/proofs/keyless/x` |'
	# shellcheck disable=SC2016  # literal Markdown code spans in the expected row
	_t "a newline in the detail cannot end the row early" \
		"$(keyless_ledger_row 2026-09-20 gcp postgres FAIL abc1234 "$(printf 'one\ntwo')" b)" \
		'| 2026-09-20 | gcp | postgres | **FAIL** | `abc1234` | one two `b` |'

	if [[ "$fails" -gt 0 ]]; then
		echo "keyless-db-e2e --self-test: $fails assertion(s) FAILED" >&2
		exit 1
	fi
	echo "keyless-db-e2e --self-test: OK"
	exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════════════════════
# RUN PATH
# ══════════════════════════════════════════════════════════════════════════════════════════════

cloud="${1:?usage: keyless-db-e2e.sh <aws|gcp|azure> <postgres|mysql> | --self-test}"
engine="${2:?usage: keyless-db-e2e.sh <aws|gcp|azure> <postgres|mysql> | --self-test}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bundle="demos/proofs/keyless/${cloud}-${engine}/${stamp}"
outdir="$root/$bundle"
ledger="$root/demos/proofs/keyless-db-e2e-log.md"

case "$engine" in postgres | mysql) ;; *)
	echo "unknown engine $engine" >&2
	exit 2
	;;
esac

# ── the cell gate. Refuse a cell the PRODUCT excludes, rather than recording a failure against a
#    boundary that is working. See keyless_cell_lane / keyless_exclusion_reason above.
case "$(keyless_cell_lane "$cloud")" in
excluded)
	keyless_exclusion_reason "$cloud" >&2
	echo "See docs/testing/keyless-db-parity.md." >&2
	exit 2
	;;
unknown)
	echo "unknown cloud $cloud" >&2
	exit 2
	;;
esac

mkdir -p "$outdir"
log="$outdir/run.log"
summary_json="$outdir/keyless-summary.json"

# The REAL test name — never an aspirational one. registry-e2e.sh invoked TestT2XacctRegistry, which
# existed in no file, so it recorded BLOCKED forever; a script that names a test nobody wrote is worse
# than no script. Fixed in #1047, and now guarded by TestScriptRunTargetsResolveToRealTests
# (test/e2e/nightly_reachability_test.go), which fails CI on any unresolvable `-run` target.
run=(go test -tags=e2e_t2 ./... -run "TestT2RealCloudProvisioning" -count=1 -timeout 80m -v)
dir="test/e2e"

# ── run (or record BLOCKED) ──────────────────────────────────────────────────────────────────
detail=""
if [[ -n "${BLOCKED:-}" ]]; then
	verdict="BLOCKED"
	detail="$BLOCKED"
	printf 'BLOCKED: %s\n' "$BLOCKED" | tee "$log" >/dev/null
else
	echo "▶ keyless-db $cloud/$engine @ $sha → $bundle" >&2
	# ALETHIA_E2E_KEYLESS_DB_SUMMARY is what makes the verdict knowable at all: writeKeylessSummary
	# returns early when it is empty, and without the summary every real run would classify BLOCKED.
	(
		cd "$root/$dir" && ALETHIA_E2E_PROVIDER="$cloud" \
			ALETHIA_E2E_KEYLESS_DB=1 ALETHIA_E2E_KEYLESS_DB_ENGINE="$engine" \
			ALETHIA_E2E_KEYLESS_DB_SUMMARY="$summary_json" \
			GOWORK=off "${run[@]}"
	) >"$log" 2>&1
	rc=$?
	verdict="$(keyless_classify_verdict "$rc" "$log" "$summary_json" "$cloud" "$engine")"
	mismatch="$(keyless_summary_mismatch "$summary_json" "$cloud" "$engine")"
	case "$verdict" in
	BLOCKED)
		if [[ -n "$mismatch" ]]; then
			detail="summary measured $mismatch, not $cloud/$engine — this cell did not run"
		else
			detail="keyless stage did not run (no summary written)"
		fi
		;;
	esac
	detail="${detail:-$(grep -E "keyless: |FAIL:|Error:|--- (PASS|FAIL)" "$log" | tail -1)}"
fi

# ── scrub the log (best-effort; the bundle must be secret-clean) ──────────────────────────────
if [[ -f "$root/demos/proofs/scrub.sh" ]]; then
	# shellcheck source=/dev/null
	source "$root/demos/proofs/scrub.sh" 2>/dev/null && scrub_file "$log" 2>/dev/null || true
fi
cat >"$outdir/provision-summary.json" <<EOF
{"feature":"keyless-db","cloud":"$cloud","engine":"$engine","verdict":"$verdict",
 "git_sha":"$sha","captured_at":"$stamp","detail":$(printf '%s' "${detail:-}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '""')}
EOF

# ── append the ledger (idempotent: one row per run) ──────────────────────────────────────────
row="$(keyless_ledger_row "$(date -u +%Y-%m-%d)" "$cloud" "$engine" "$verdict" "$sha" "${detail:-}" "$bundle")"
# ── APPEND AT THE END, not directly beneath the sentinel. ──
#
# `collapseLedger` (scripts/programme-rollup.mjs) replays rows in FILE ORDER and lets the last one
# win. This wrote each new row immediately BELOW the sentinel, i.e. newest-first. Newest-first
# storage read as last-wins means the OLDEST row wins.
#
# Measured 2026-08-24: a hetzner/floor PASS was masked by the FAIL from three hours earlier, and
# PROGRAMME.md reported "0 proven" with the proof sitting in the same file. All five ledger engines
# have always done this. It could not bite until now only because no (cloud × dimension) pair had
# ever had two rows below the sentinel — there was exactly one row down there. A re-run-until-green
# cadence produces that condition immediately, and it bit on the first re-run.
#
# The sentinel stays as the marker for where the appended region begins; a file without one is not
# the shape this writes into, so say so rather than appending blind.
if ! grep -q "keyless-db-e2e.sh appends new rows below this line" "$ledger" 2>/dev/null; then
	echo "::warning::keyless-db-e2e.sh: ledger $ledger has no append sentinel — appending at end of file anyway." >&2
fi
printf '%s\n' "$row" >>"$ledger"
echo "recorded: $verdict → $bundle (ledger appended)" >&2

# ── on FAIL: file/update a title-deduped GitHub issue ────────────────────────────────────────
if [[ "$verdict" == "FAIL" && -z "${NO_ISSUE:-}" ]] && command -v gh >/dev/null 2>&1; then
	title="e2e: keyless-db ${cloud}/${engine} FAIL"
	existing="$(gh issue list --state open --search "\"$title\" in:title" --json number -q '.[0].number' 2>/dev/null)"
	body="$title at \`$sha\` (${stamp}). Proof: \`$bundle\`. Last line: ${detail:-see bundle}. Auto-filed by keyless-db-e2e.sh; re-run to update."
	if [[ -n "$existing" ]]; then
		gh issue comment "$existing" --body "Recurred @ $sha ($stamp) — \`$bundle\`" >/dev/null 2>&1 || true
	else gh issue create --title "$title" --label "wave:hygiene,lane:tests" --body "$body" >/dev/null 2>&1 || true; fi
	echo "issue filed/updated: $title" >&2
fi

[[ "$verdict" == "PASS" ]]
