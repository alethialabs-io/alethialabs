#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# secrets-e2e.sh <cloud> <stage> — run ONE cross-account keyless SECRETS e2e and PERSIST it (#1268).
#
# The "every run is recorded" engine for the xacct-secrets parity board, mirroring registry-e2e.sh:
# it runs the env-gated test, captures a scrubbed proof bundle, appends the append-only ledger, and
# on FAILURE files (or updates) a title-deduped GitHub issue — so the history accumulates and a bad
# night is never merely forgotten.
#
#   cloud : aws | gcp | azure | alibaba
#   stage : cluster — the nightly lane: a real cluster in account A reads a secret from account B
#                     through secretstore-<cloud>-xacct, value compared by SHA-256.
#           strict  — the one-shot MANUAL run that closes the documented trust-shape divergence:
#                     apply infra/connector/<cloud>/secrets-xacct VERBATIM (exact-ARN trust) against
#                     a live run's real IRSA ARN, then re-run the same test. The nightly's account-B
#                     trust is pattern-bound (infra/aws-secrets-e2e) because the cluster is
#                     ephemeral; this stage proves the SHIPPED module's shape works too.
#
# AWS and GCP can run (GCP against an ADOPTED standing GSA, #1268). azure/alibaba record BLOCKED
# with the reason from secretsXacctLane
# (test/e2e/t2_secrets_xacct.go) — the SAME text the parity board quotes, so a lane cannot look
# covered here while being blocked there. A run that can't proceed is recorded as BLOCKED, never
# skipped silently: a SKIPPED test is classified BLOCKED, never PASS — and PASS is read from the
# scenario's own summary file, so a base T2 pass with the scenario turned off cannot become one.
#
# The caller exports the target env (see docs/testing/e2e-nightly-enablement.md):
#   ALETHIA_E2E_SECRETS_XACCT=1 ALETHIA_E2E_SECRETS_XACCT_{ACCOUNT,REGION,ROLE_ARN,REMOTE_KEY,EXPECT_SHA256}
#   (gcp: ALETHIA_E2E_SECRETS_XACCT_{PROJECT_ID,REMOTE_KEY,EXPECT_SHA256,ESO_GSA_EMAIL} instead)
#   plus the provider creds the base T2 proof needs.
#
# Env knobs: NO_ISSUE=1 (don't file a GH issue on fail) · BLOCKED="<reason>" (force a BLOCKED record).
set -uo pipefail

cloud="${1:?usage: secrets-e2e.sh <aws|gcp|azure|alibaba> <cluster|strict>}"
stage="${2:?usage: secrets-e2e.sh <aws|gcp|azure|alibaba> <cluster|strict>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bundle="demos/proofs/${cloud}/${stamp}"
outdir="$root/$bundle"
ledger="$root/demos/proofs/xacct-secrets-e2e-log.md"
mkdir -p "$outdir"
log="$outdir/run.log"

case "$cloud" in aws|gcp|azure|alibaba) ;; *) echo "unknown cloud $cloud" >&2; exit 2 ;; esac
case "$stage" in cluster|strict) ;; *) echo "unknown stage $stage" >&2; exit 2 ;; esac
# `strict` is an AWS trust-shape run (exact-ARN trust vs the nightly's pattern-bound trust). The run
# command below does not depend on the stage, so `gcp strict` would record a SECOND row for the very
# same run as `gcp cluster`. Refuse it rather than let one run count twice.
if [[ "$stage" == "strict" && "$cloud" != "aws" ]]; then
  echo "stage strict is aws-only: it closes the AWS exact-ARN trust divergence; $cloud has none to close" >&2; exit 2
fi

# ── the lane gate. AWS and GCP can be proven; the others record WHY, never a silent skip.
#    The authoritative reasons live in secretsXacctLane (test/e2e/t2_secrets_xacct.go) — a pure test
#    asserts they stay substantive, and docs/testing/xacct-secrets-parity.md carries them in full.
#    These are the one-line summaries; keep them pointing at that board rather than restating it.
if [[ -z "${BLOCKED:-}" ]]; then
  case "$cloud" in
    azure)   BLOCKED="azure: the cross-subscription role assignment binds the managed identity's object id, regenerated on every create (adopting a standing identity removes that half); still needs a second subscription in the same tenant and an account-B stack — see docs/testing/xacct-secrets-parity.md." ;;
    alibaba) BLOCKED="alibaba: ESO's RRSA needs a RAM OIDC provider registered against THIS cluster's ACK issuer — inherently per-cluster. Honest exclusion; see docs/testing/xacct-secrets-parity.md." ;;
  esac
fi

# The REAL test name — never an aspirational one. registry-e2e.sh spent months invoking
# TestT2XacctRegistry, which existed in no file, recording BLOCKED forever while the board reported
# the harness as shipped (#1047, now fixed). TestScriptRunTargetsResolveToRealTests
# (test/e2e/nightly_reachability_test.go) makes that impossible to repeat.
run=(go test -tags=e2e_t2 ./... -run "TestT2RealCloudProvisioning" -count=1 -timeout 80m -v)
dir="test/e2e"

# ── run (or record BLOCKED) ──────────────────────────────────────────────────────────────────
if [[ -n "${BLOCKED:-}" ]]; then
  verdict="BLOCKED"; detail="$BLOCKED"
  printf 'BLOCKED: %s\n' "$BLOCKED" | tee "$log" >/dev/null
else
  echo "▶ xacct-secrets $cloud/$stage @ $sha → $bundle" >&2
  # PASS is read from the SCENARIO's own summary, never from `go test`'s exit code alone. The test
  # this runs is the BASE T2 proof; the cross-account read is one scenario inside it, and decide()
  # (test/e2e/t2_secrets_xacct.go) can turn that scenario OFF with a logged reason — a blocked
  # lane, or a gcp run with neither PROJECT_ID nor ESO_GSA_EMAIL set — while the base proof passes
  # and the process exits 0. Reading the exit code recorded exactly that as PASS for a read that
  # never ran. runT2SecretsXacct writes this file ONLY when the scenario actually ran, and its
  # verdict starts as FAIL and becomes PASS only after the last assertion; so "no file" means "did
  # not run" and the file's verdict is the scenario's own. Removed first so a stale file from an
  # earlier run in the same bundle dir can never be read as this run's.
  summary="$outdir/secrets-xacct-summary.json"
  rm -f "$summary"
  ( cd "$root/$dir" && ALETHIA_E2E_SECRETS_XACCT=1 ALETHIA_E2E_SECRETS_XACCT_SUMMARY="$summary" GOWORK=off "${run[@]}" ) >"$log" 2>&1
  rc=$?
  scenario="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("verdict",""))' "$summary" 2>/dev/null || true)"
  off_line="$(grep -m1 -oE '#1268: cross-account keyless secrets (BLOCKED|SKIPPED).*' "$log" | sed 's/|/;/g' || true)"
  if [[ $rc -eq 0 && "$scenario" == "PASS" ]]; then verdict="PASS"
  elif [[ $rc -eq 0 && -n "$off_line" ]]; then
    verdict="BLOCKED"; detail="scenario did not run: $off_line"
  elif [[ $rc -eq 0 ]] && grep -q "^--- SKIP\|^ok.*\[no tests to run\]\|SKIP:" "$log" && ! grep -q "FAIL" "$log"; then
    verdict="BLOCKED"; detail="test SKIPPED (env not set)"
  elif [[ $rc -eq 0 ]]; then
    # go test passed and nothing says the scenario was turned off, yet it left no PASS summary.
    # That is not a proof of anything, so it is not recorded as one.
    verdict="FAIL"; detail="go test exited 0 but the scenario recorded no PASS summary (verdict='${scenario:-none}')"
  else verdict="FAIL"; fi
  # Prefer the scenario's own verdict line when present.
  detail="${detail:-$(grep -E "xacct: |FAIL:|Error:|--- (PASS|FAIL)" "$log" | tail -1 | sed 's/|/;/g')}"
fi

# ── scrub the log (best-effort; the bundle must be secret-clean) ──────────────────────────────
if [[ -f "$root/demos/proofs/scrub.sh" ]]; then
  # shellcheck source=/dev/null
  source "$root/demos/proofs/scrub.sh" 2>/dev/null && scrub_file "$log" 2>/dev/null || true
fi
cat >"$outdir/provision-summary.json" <<EOF
{"feature":"xacct-secrets","cloud":"$cloud","stage":"$stage","verdict":"$verdict",
 "git_sha":"$sha","captured_at":"$stamp","detail":$(printf '%s' "${detail:-}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '""')}
EOF

# ── append the ledger (idempotent: one row per run) ──────────────────────────────────────────
row="| $(date -u +%Y-%m-%d) | $sha | $cloud | $stage | **$verdict** | ${detail:-} | \`$bundle\` | — |"
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
if ! grep -q "secrets-e2e.sh appends new rows below this line" "$ledger" 2>/dev/null; then
  echo "::warning::secrets-e2e.sh: ledger $ledger has no append sentinel — appending at end of file anyway." >&2
fi
printf '%s\n' "$row" >>"$ledger"
echo "recorded: $verdict → $bundle (ledger appended)" >&2

# ── on FAIL: file/update a title-deduped GitHub issue ────────────────────────────────────────
if [[ "$verdict" == "FAIL" && -z "${NO_ISSUE:-}" ]] && command -v gh >/dev/null 2>&1; then
  title="e2e: xacct-secrets ${cloud}/${stage} FAIL"
  existing="$(gh issue list --state open --search "\"$title\" in:title" --json number -q '.[0].number' 2>/dev/null)"
  body="$title at \`$sha\` (${stamp}). Proof: \`$bundle\`. Last line: ${detail:-see bundle}. Auto-filed by secrets-e2e.sh; re-run to update."
  if [[ -n "$existing" ]]; then gh issue comment "$existing" --body "Recurred @ $sha ($stamp) — \`$bundle\`" >/dev/null 2>&1 || true
  else gh issue create --title "$title" --label "wave:connectors-v2,lane:tests,security" --body "$body" >/dev/null 2>&1 || true; fi
  echo "issue filed/updated: $title" >&2
fi

[[ "$verdict" == "PASS" ]]
