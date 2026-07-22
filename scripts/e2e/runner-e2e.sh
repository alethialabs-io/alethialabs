#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# runner-e2e.sh <cloud> <stage> — run ONE per-cloud runner e2e and PERSIST it.
#
# The "every run is recorded" engine for the runner→cluster parity board (mirrors registry-e2e.sh).
# It runs the matching check, appends the append-only ledger, and on FAILURE files (or updates) a
# title-deduped GitHub issue. History accumulates; nothing is lost.
#
#   cloud : aws | gcp | azure | alibaba | hetzner
#   stage : register — the published `runner-<cloud>:latest` amd64 image ships a genuine x86-64
#                       runner binary (the exact regression that crash-looped every x86 fleet VM in
#                       INCIDENT 2026-07-22). No cloud, no VM — pull + inspect the ELF.
#           cluster  — the full real-apply: a runner provisions a real K8s cluster on <cloud>
#                       (T2, `test/e2e -tags=e2e_t2 TestT2RealCloudProvisioning`). Real money.
#
# The caller exports the test env for `cluster` (see the T2 test / e2e-nightly.yml gate vars):
#   aws     : AWS creds (OIDC role) + ALETHIA_E2E_AWS_READY=1
#   gcp     : GOOGLE_* WIF creds
#   azure   : ARM_* federated creds
#   alibaba : ALICLOUD_* / STS federated creds
#   hetzner : HCLOUD_TOKEN
#   all     : ALETHIA_DATABASE_URL, ALETHIA_E2E_REGION, ALETHIA_E2E_CLUSTER_JSON (managed clouds)
#
# A run that can't proceed (missing env/quota) is recorded as BLOCKED, not skipped silently.
# Env knobs: NO_ISSUE=1 (don't file a GH issue) · BLOCKED="<reason>" (force a BLOCKED record) ·
#            IMAGE_TAG=latest (register stage) · REGISTRY=ghcr.io/alethialabs-io.
set -uo pipefail

cloud="${1:?usage: runner-e2e.sh <aws|gcp|azure|alibaba|hetzner> <register|cluster>}"
stage="${2:?usage: runner-e2e.sh <aws|gcp|azure|alibaba|hetzner> <register|cluster>}"
case "$cloud" in aws|gcp|azure|alibaba|hetzner) ;; *) echo "unknown cloud $cloud" >&2; exit 2 ;; esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bundle="demos/proofs/${cloud}/${stamp}"
outdir="$root/$bundle"; mkdir -p "$outdir"
ledger="$root/demos/proofs/runner-xcloud-e2e-log.md"
log="$outdir/run.log"
verdict=""; detail=""

if [[ -n "${BLOCKED:-}" ]]; then
  verdict="BLOCKED"; detail="$BLOCKED"; printf 'BLOCKED: %s\n' "$BLOCKED" | tee "$log" >/dev/null
else
  case "$stage" in
    register)
      # Pull the published amd64 image + assert its /runner is a real x86-64 ELF (e_machine 0x3e).
      # 0xb7 = aarch64 = the INCIDENT bug (arm64 binary in the amd64 image → ENOEXEC crash-loop).
      img="${REGISTRY:-ghcr.io/alethialabs-io}/runner-${cloud}:${IMAGE_TAG:-latest}"
      echo "▶ $cloud/register: $img (amd64 ELF arch)" | tee "$log" >&2
      if em=$(docker run --rm --pull=always --platform linux/amd64 --entrypoint sh "$img" \
                -c 'od -An -tx1 -j18 -N2 /usr/local/bin/runner' 2>>"$log" | tr -d ' '); then
        echo "amd64 /runner e_machine=$em" | tee -a "$log" >&2
        if [[ "$em" == "3e00" ]]; then verdict="PASS"; detail="amd64 runner is x86-64 (e_machine=0x3e)"
        elif [[ "$em" == "b700" ]]; then verdict="FAIL"; detail="amd64 image ships an ARM64 runner (e_machine=0xb7) — the INCIDENT bug"
        else verdict="FAIL"; detail="unexpected e_machine=$em"; fi
      else verdict="FAIL"; detail="could not pull/inspect $img"; fi ;;
    cluster)
      echo "▶ $cloud/cluster: T2 real-apply" | tee "$log" >&2
      ( cd "$root/test/e2e" && ALETHIA_E2E_PROVIDER="$cloud" GOWORK=off \
          go test -tags=e2e_t2 ./... -run TestT2RealCloudProvisioning -count=1 -timeout 80m -v ) >>"$log" 2>&1
      rc=$?
      if [[ $rc -eq 0 ]] && grep -qE "^ok|^--- PASS|^PASS" "$log"; then verdict="PASS"
      elif grep -qE "^--- SKIP|\[no tests to run\]|SKIP:" "$log" && ! grep -q "FAIL" "$log"; then
        verdict="BLOCKED"; detail="T2 SKIPPED (cloud gate not set)"
      else verdict="FAIL"; fi
      # best-effort: a real cluster run also drops a scrubbed proof bundle
      [[ -x "$root/demos/proofs/capture-proof.sh" ]] && \
        ALETHIA_E2E_PROOF_OUTCOME="$([[ $verdict == PASS ]] && echo success || echo failure)" \
        ALETHIA_E2E_T2_RUNNER_LOG="$log" "$root/demos/proofs/capture-proof.sh" "$cloud" "$stamp" >/dev/null 2>&1 || true ;;
    *) echo "unknown stage $stage (register|cluster)" >&2; exit 2 ;;
  esac
  detail="${detail:-$(grep -E "OK — |FAIL:|Error:|--- (PASS|FAIL)" "$log" | tail -1 | sed 's/|/;/g')}"
fi

# ── scrub (the bundle must be secret-clean) ──────────────────────────────────────────────────
if [[ -f "$root/demos/proofs/scrub.sh" ]]; then
  # shellcheck source=/dev/null
  source "$root/demos/proofs/scrub.sh" 2>/dev/null && scrub_file "$log" 2>/dev/null || true
fi

# ── append the ledger (newest below the marker) ──────────────────────────────────────────────
row="| $(date -u +%Y-%m-%d) | $sha | $cloud | $stage | **$verdict** | ${detail:-} | \`$bundle\` | — |"
if grep -q "runner-e2e.sh appends new rows below this line" "$ledger" 2>/dev/null; then
  awk -v r="$row" '/appends new rows below this line/{print;print r;next}1' "$ledger" >"$ledger.tmp" && mv "$ledger.tmp" "$ledger"
else printf '%s\n' "$row" >>"$ledger"; fi
echo "recorded: $verdict → $bundle (ledger appended)" >&2

# ── on FAIL: file/update a title-deduped GitHub issue (mirror the e2e-nightly filer) ─────────
if [[ "$verdict" == "FAIL" && -z "${NO_ISSUE:-}" ]] && command -v gh >/dev/null 2>&1; then
  title="e2e: runner ${cloud}/${stage} FAIL"
  existing="$(gh issue list --state open --search "\"$title\" in:title" --json number -q '.[0].number' 2>/dev/null)"
  body="$title at \`$sha\` (${stamp}). Proof: \`$bundle\`. Last line: ${detail:-see bundle}. Auto-filed by runner-e2e.sh (tracking #1050); re-run to update."
  if [[ -n "$existing" ]]; then gh issue comment "$existing" --body "Recurred @ $sha ($stamp) — \`$bundle\`" >/dev/null 2>&1 || true
  else gh issue create --title "$title" --label "lane:tests" --body "$body" >/dev/null 2>&1 || true; fi
  echo "issue filed/updated: $title" >&2
fi

[[ "$verdict" == "PASS" ]]
