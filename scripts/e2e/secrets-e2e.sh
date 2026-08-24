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
# Only AWS can run today. gcp/azure/alibaba record BLOCKED with the reason from secretsXacctLane
# (test/e2e/t2_secrets_xacct.go) — the SAME text the parity board quotes, so a lane cannot look
# covered here while being blocked there. A run that can't proceed is recorded as BLOCKED, never
# skipped silently: a SKIPPED test is classified BLOCKED, never PASS.
#
# The caller exports the target env (see docs/testing/e2e-nightly-enablement.md):
#   ALETHIA_E2E_SECRETS_XACCT=1 ALETHIA_E2E_SECRETS_XACCT_{ACCOUNT,REGION,ROLE_ARN,REMOTE_KEY,EXPECT_SHA256}
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

# ── the lane gate. Only AWS can be proven today; the others record WHY, never a silent skip.
#    The authoritative reasons live in secretsXacctLane (test/e2e/t2_secrets_xacct.go) — a pure test
#    asserts they stay substantive, and docs/testing/xacct-secrets-parity.md carries them in full.
#    These are the one-line summaries; keep them pointing at that board rather than restating it.
if [[ -z "${BLOCKED:-}" && "$cloud" != "aws" ]]; then
  case "$cloud" in
    gcp)     BLOCKED="gcp: the per-run external-secrets GSA cannot carry a pre-applied cross-project grant (a same-named recreation is a new identity; GCP IAM has no principal-pattern condition). Unblocked by adopting a standing GSA — see docs/testing/xacct-secrets-parity.md." ;;
    azure)   BLOCKED="azure: the cross-subscription role assignment binds the managed identity's object id, regenerated on every create; also needs a second subscription in the same tenant. Unblocked by adopting a standing identity — see docs/testing/xacct-secrets-parity.md." ;;
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
  ( cd "$root/$dir" && ALETHIA_E2E_SECRETS_XACCT=1 GOWORK=off "${run[@]}" ) >"$log" 2>&1
  rc=$?
  if [[ $rc -eq 0 ]] && grep -q "^ok\|^--- PASS\|^PASS" "$log"; then verdict="PASS"
  elif grep -q "^--- SKIP\|^ok.*\[no tests to run\]\|SKIP:" "$log" && ! grep -q "FAIL" "$log"; then
    verdict="BLOCKED"; detail="test SKIPPED (env not set)"
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
