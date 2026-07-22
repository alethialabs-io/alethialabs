#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# registry-e2e.sh <cloud> <stage> — run ONE cross-account keyless registry e2e and PERSIST it.
#
# The "every run is recorded" engine for the xacct-registry parity board. It runs the matching
# env-gated test, captures a scrubbed proof bundle, appends the append-only ledger, and on FAILURE
# files (or updates) a title-deduped GitHub issue. So the history accumulates and nothing is lost.
#
#   cloud : aws | gcp | azure
#   stage : mint     — the registry-token mint func vs a live registry, proven to pull (no cluster).
#           cluster  — the full in-cluster WI → refresher → patch → pod pull (T2, real cluster).
#
# The caller sets up the target-account trust + a scoped cross-account image and exports the test env:
#   mint/aws  : ALETHIA_E2E_ECR_ROLE ALETHIA_E2E_ECR_HOST ALETHIA_E2E_ECR_REGION ALETHIA_E2E_ECR_IMAGE
#   mint/gcp  : ALETHIA_E2E_GAR_HOST ALETHIA_E2E_GAR_IMAGE            (+ ambient GCP ADC)
#   mint/azure: ALETHIA_E2E_ACR_HOST ALETHIA_E2E_ACR_IMAGE ALETHIA_E2E_ACR_AAD_TOKEN
#   cluster/* : ALETHIA_E2E_XACCT_REGISTRY=1 + the provider creds + ALETHIA_E2E_XACCT_* (see the T2 test)
#
# A run that can't proceed (missing env/quota) is recorded as BLOCKED, not skipped silently.
#
# Env knobs: NO_ISSUE=1 (don't file a GH issue on fail) · BLOCKED="<reason>" (force a BLOCKED record).
set -uo pipefail

cloud="${1:?usage: registry-e2e.sh <aws|gcp|azure> <mint|cluster>}"
stage="${2:?usage: registry-e2e.sh <aws|gcp|azure> <mint|cluster>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bundle="demos/proofs/${cloud}/${stamp}"
outdir="$root/$bundle"
ledger="$root/demos/proofs/xacct-registry-e2e-log.md"
mkdir -p "$outdir"
log="$outdir/run.log"

# ── select the test ──────────────────────────────────────────────────────────────────────────
case "$stage" in
  mint)
    case "$cloud" in
      aws)   run=(go test ./internal/agent/ -run TestRealECRMint -count=1 -v) ; dir="apps/runner" ;;
      gcp)   run=(go test ./internal/agent/ -run TestRealGARMint -count=1 -v) ; dir="apps/runner" ;;
      azure) run=(go test ./internal/agent/ -run TestRealACRExchange -count=1 -v) ; dir="apps/runner" ;;
      *) echo "unknown cloud $cloud" >&2; exit 2 ;;
    esac ;;
  cluster)
    run=(go test -tags=e2e_t2 ./... -run "TestT2XacctRegistry" -count=1 -timeout 80m -v) ; dir="test/e2e" ;;
  *) echo "unknown stage $stage" >&2; exit 2 ;;
esac

# ── run (or record BLOCKED) ──────────────────────────────────────────────────────────────────
if [[ -n "${BLOCKED:-}" ]]; then
  verdict="BLOCKED"; detail="$BLOCKED"
  printf 'BLOCKED: %s\n' "$BLOCKED" | tee "$log" >/dev/null
else
  echo "▶ $cloud/$stage @ $sha → $bundle" >&2
  ( cd "$root/$dir" && GOWORK=off "${run[@]}" ) >"$log" 2>&1
  rc=$?
  if [[ $rc -eq 0 ]] && grep -q "^ok\|^--- PASS\|^PASS" "$log"; then verdict="PASS"
  elif grep -q "^--- SKIP\|^ok.*\[no tests to run\]\|SKIP:" "$log" && ! grep -q "FAIL" "$log"; then
    verdict="BLOCKED"; detail="test SKIPPED (env not set)"
  else verdict="FAIL"; fi
  detail="${detail:-$(grep -E "OK — |FAIL:|Error:|--- (PASS|FAIL)" "$log" | tail -1 | sed 's/|/;/g')}"
fi

# ── scrub the log (best-effort; the bundle must be secret-clean) ──────────────────────────────
if [[ -f "$root/demos/proofs/scrub.sh" ]]; then
  # shellcheck source=/dev/null
  source "$root/demos/proofs/scrub.sh" 2>/dev/null && scrub_file "$log" 2>/dev/null || true
fi
cat >"$outdir/provision-summary.json" <<EOF
{"feature":"xacct-registry","cloud":"$cloud","stage":"$stage","verdict":"$verdict",
 "git_sha":"$sha","captured_at":"$stamp","detail":$(printf '%s' "${detail:-}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '""')}
EOF

# ── append the ledger (idempotent: one row per run) ──────────────────────────────────────────
row="| $(date -u +%Y-%m-%d) | $sha | $cloud ($stage) | $stage | **$verdict** | ${detail:-} | \`$bundle\` | — |"
if grep -q "registry-e2e.sh appends new rows below this line" "$ledger" 2>/dev/null; then
  awk -v r="$row" '/appends new rows below this line/{print;print r;next}1' "$ledger" >"$ledger.tmp" && mv "$ledger.tmp" "$ledger"
else printf '%s\n' "$row" >>"$ledger"; fi
echo "recorded: $verdict → $bundle (ledger appended)" >&2

# ── on FAIL: file/update a title-deduped GitHub issue (mirror the e2e-nightly filer) ─────────
if [[ "$verdict" == "FAIL" && -z "${NO_ISSUE:-}" ]] && command -v gh >/dev/null 2>&1; then
  title="e2e: xacct-registry ${cloud}/${stage} FAIL"
  existing="$(gh issue list --state open --search "\"$title\" in:title" --json number -q '.[0].number' 2>/dev/null)"
  body="$title at \`$sha\` (${stamp}). Proof: \`$bundle\`. Last line: ${detail:-see bundle}. Auto-filed by registry-e2e.sh; re-run to update."
  if [[ -n "$existing" ]]; then gh issue comment "$existing" --body "Recurred @ $sha ($stamp) — \`$bundle\`" >/dev/null 2>&1 || true
  else gh issue create --title "$title" --label "wave:connectors-v2,lane:tests,security" --body "$body" >/dev/null 2>&1 || true; fi
  echo "issue filed/updated: $title" >&2
fi

[[ "$verdict" == "PASS" ]]
