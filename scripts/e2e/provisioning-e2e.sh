#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# provisioning-e2e.sh <cloud> <dimension> — run ONE real-cloud provisioning e2e and PERSIST it.
#
# The "every run is recorded" engine for the provisioning parity board
# (docs/testing/provisioning-e2e-parity.md). It drives the T2 harness at a chosen fidelity, captures a
# scrubbed proof bundle, appends the append-only ledger, and on FAILURE files (or updates) a title-deduped
# GitHub issue. Sibling of scripts/e2e/registry-e2e.sh; same mechanics (scrub + ledger sentinel + dedup).
#
#   cloud     : aws | gcp | azure | alibaba | hetzner
#   dimension : floor     — base T2: provision + cluster_ready + ArgoCD Healthy+Synced (cheapest shape),
#                           and NOTHING else. The A0.3 soak is explicitly OFF here: its drift check is
#                           fatal, and a floor run that met every documented floor requirement was
#                           filed a floor FAIL on it (#2356).
#               maxconfig — + ALETHIA_E2E_MAX_CONFIG=1  (all 11 resource kinds land in tofu state).
#               addons    — + ALETHIA_E2E_ALL_ADDONS=1  (all 18 marketplace add-ons Healthy+Synced;
#                           18 not 19 — cert-manager moved to the platform rail, #1722).
#               byo       — + the A0.6 bring-your-own HELM CHART + apps-repo ArgoCD proof (needs
#                           ALETHIA_E2E_ARGO_* + _GIT_TOKEN). NOT bring-your-own IaC: no customer
#                           OpenTofu runs in this dimension. It was labelled "BYO-IaC" here and in
#                           demos/proofs/provisioning-e2e-log.md, so the ledger has been recording a
#                           customer-tofu proof that has never run.
#               day2      — + the A0.3 day-2 soak (liveness, drift posture, PVC). E2E_SOAK widens or
#                           narrows the window; it cannot switch it off, because a day-2 dimension
#                           with no soak asserts nothing.
#               full      — every dimension above in one real apply (the FULLY-TESTED bar).
#
# The dimension list and the env each one switches on live in ONE place — DIMENSIONS and
# fidelity_env in scripts/e2e/resolve-dimension.sh, which self-tests the pair. They were written out
# both here and in the workflow's step env, and the two disagreed (#2356).
#
# The caller provides the cloud creds (keyless OIDC/WIF/federated, per the nightly) and the control-plane
# DB. This engine sets the fidelity env for the chosen dimension and requires a hard verdict
# (ALETHIA_E2E_T2_REQUIRE=1) so a missing-creds skip is recorded as BLOCKED, not a false green.
#
# Prereqs (mirror .github/workflows/e2e-nightly.yml): tofu/kubectl/helm/go on PATH, ALETHIA_DATABASE_URL
# pointing at a migrated control-plane Postgres, the cloud's creds active, and (managed clouds)
# ALETHIA_E2E_CLUSTER_JSON pinning the cheapest shape.
#
# Env knobs:
#   NO_ISSUE=1                 — don't file a GH issue on FAIL.
#   BLOCKED="<reason>"         — force a BLOCKED record without running (e.g. quota denied).
#   RECORD_ONLY=1              — don't run; append a ledger row from an existing bundle. Used by the nightly
#                                rollup. Requires RECORD_VERDICT + RECORD_BUNDLE (+ optional RECORD_DETAIL,
#                                RECORD_SHA, RECORD_ISSUE).
#   ALETHIA_E2E_REGION=...     — region override (else the workflow's per-cloud cheap default).
set -uo pipefail

cloud="${1:?usage: provisioning-e2e.sh <aws|gcp|azure|alibaba|hetzner> <floor|maxconfig|addons|byo|day2|full>}"
dimension="${2:?usage: provisioning-e2e.sh <cloud> <floor|maxconfig|addons|byo|day2|full>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
ledger="$root/demos/proofs/provisioning-e2e-log.md"

case "$cloud" in aws|gcp|azure|alibaba|hetzner) ;; *) echo "unknown cloud $cloud" >&2; exit 2 ;; esac

# DIMENSIONS and fidelity_env live in resolve-dimension.sh — ONE table, so the dimension this
# validates, the env it sets and the row it appends can never disagree. Sourced, not executed
# (#1755, and #2356 for the fidelity half).
# shellcheck source=scripts/e2e/resolve-dimension.sh
. "$(dirname "${BASH_SOURCE[0]}")/resolve-dimension.sh"

case " $DIMENSIONS " in *" $dimension "*) ;; *) echo "unknown dimension $dimension (want one of: $DIMENSIONS)" >&2; exit 2 ;; esac

# ── append one ledger row after the sentinel (idempotent shape; awk fallback to >>) ────────────
append_ledger() {
  local sha="$1" verdict="$2" detail="$3" bundle="$4" issue="$5"
  # Free-text detail is the only untrusted column — a literal `|` would break the markdown table
  # (the RUN path pre-sanitizes, but the RECORD_ONLY path passes RECORD_DETAIL through verbatim),
  # so neutralize it here for every caller. Also collapse newlines to keep the row on one line.
  detail="${detail//|/;}"; detail="${detail//$'\n'/ }"
  local row="| $(date -u +%Y-%m-%d) | $sha | $cloud | $dimension | **$verdict** | ${detail:-} | \`$bundle\` | ${issue:-—} |"
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
  if ! grep -q "provisioning-e2e.sh appends new rows below this line" "$ledger" 2>/dev/null; then
    echo "::warning::provisioning-e2e.sh: ledger $ledger has no append sentinel — appending at end of file anyway." >&2
  fi
  printf '%s\n' "$row" >>"$ledger"
  echo "recorded: $verdict → ${bundle} (ledger appended)" >&2
}

# ── RECORD_ONLY: append from an existing bundle (nightly rollup path) ───────────────────────────
if [[ -n "${RECORD_ONLY:-}" ]]; then
  append_ledger "${RECORD_SHA:-$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)}" \
    "${RECORD_VERDICT:?RECORD_ONLY needs RECORD_VERDICT}" "${RECORD_DETAIL:-}" \
    "${RECORD_BUNDLE:?RECORD_ONLY needs RECORD_BUNDLE}" "${RECORD_ISSUE:-—}"
  exit 0
fi

sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bundle="demos/proofs/${cloud}/${stamp}"
outdir="$root/$bundle"
mkdir -p "$outdir"
log="$outdir/run.log"

# ── fidelity env for the chosen dimension (layered: full = all of them) ────────────────────────
# From fidelity_env in resolve-dimension.sh, NOT an inline case. This used to be written out here
# AND in the workflow's step env, and the two disagreed: the workflow turned the day-2 soak on for
# every run, so a `floor` run asserted a fatal drift check that the floor's own definition does not
# mention (#2356). One table, both consumers.
declare -a dimenv=("ALETHIA_E2E_PROVIDER=$cloud" "ALETHIA_E2E_T2_REQUIRE=1")
while IFS= read -r kv; do
  [[ -n "$kv" ]] && dimenv+=("$kv")
done < <(fidelity_env "$dimension")

# ── run (or record BLOCKED) ────────────────────────────────────────────────────────────────────
if [[ -n "${BLOCKED:-}" ]]; then
  verdict="BLOCKED"; detail="$BLOCKED"
  printf 'BLOCKED: %s\n' "$BLOCKED" | tee "$log" >/dev/null
else
  echo "▶ $cloud/$dimension @ $sha → $bundle" >&2
  ( cd "$root/test/e2e" && env "${dimenv[@]}" GOWORK=off \
      go test -tags=e2e_t2 ./... -run TestT2RealCloudProvisioning -count=1 -timeout 80m -v ) >"$log" 2>&1
  rc=$?
  if [[ $rc -eq 0 ]] && grep -q "^ok\|^--- PASS\|^PASS" "$log"; then verdict="PASS"
  elif grep -q "^--- SKIP\|SKIP:\|no tests to run" "$log" && ! grep -q "FAIL" "$log"; then
    verdict="BLOCKED"; detail="test SKIPPED (creds/env not set)"
  else verdict="FAIL"; fi
  detail="${detail:-$(grep -E "cluster provisioned but not reachable|AUTH REJECTED|Error:|FAIL:|--- (PASS|FAIL)|terminal status" "$log" | tail -1 | sed 's/|/;/g' | cut -c1-200)}"
fi

# ── scrub the log — the bundle is COMMITTED to a public repo ───────────────────────────────────
# SCRUB_LITERALS must be populated BEFORE scrub_file, exactly as demos/proofs/capture-proof.sh
# does for the nightly. Without it, exact-value redaction is a no-op and only scrub.sh's
# key-name regex runs — and that regex is anchored at ^, so it matches `hcloud_token: <value>`
# on its own line but CANNOT match a secret embedded mid-line. The runner echoes the OpenTofu
# plan as ONE line of JSON containing `"hcloud_token":{"value":"…"}`, so the raw token survived
# into demos/proofs/<cloud>/<stamp>/run.log. Observed, not theoretical: a real Hetzner token
# reached a bundle on 2026-07-29 and had to be rotated.
if [[ -f "$root/demos/proofs/scrub.sh" ]]; then
  literals=""
  for v in "${HCLOUD_TOKEN:-}" "${E2E_GIT_TOKEN:-}" "${ALETHIA_E2E_GIT_TOKEN:-}" \
    "${AWS_SECRET_ACCESS_KEY:-}" "${AWS_SESSION_TOKEN:-}" "${ALICLOUD_ACCESS_KEY:-}" \
    "${ALICLOUD_SECRET_KEY:-}" "${ARM_CLIENT_SECRET:-}"; do
    [ -n "$v" ] && literals+="$v"$'\n'
  done
  SCRUB_LITERALS="$literals"
  export SCRUB_LITERALS
  # shellcheck source=/dev/null
  source "$root/demos/proofs/scrub.sh" 2>/dev/null && scrub_file "$log" 2>/dev/null || true
  # Tripwire, same as the nightly: refuse to record a bundle that still looks secret-bearing.
  # `|| true` on scrub_file above means a scrub failure is silent, so this is the actual gate.
  #
  # It does NOT delete the log. An earlier version did, on the theory that a secret-bearing
  # artifact should not survive — but the tripwire is a heuristic over key NAMES, so a false
  # positive destroyed a good bundle AND skipped the ledger row, losing the whole run's
  # evidence. Deleting is also the wrong remedy even when the hit is real: by then the secret
  # has already been written to disk, so the fix is to rotate it, not to hide the file.
  #
  # …and it no longer stops the RECORD either (#2062). Leaving the bundle but exiting before
  # the ledger kept the file and threw away the only thing that points at it: the first real
  # hetzner run of the 18-add-on set died here on five false positives, and the board then read
  # as though the run had never happened. That is the same "a green-skip is not a proof" failure
  # the ledger discipline exists to prevent, arriving from the other direction — a run that DID
  # happen, erased. A row a human still has to clear beats no row at all.
  #
  # So: mark the bundle quarantined, record the verdict the run actually earned, and carry the
  # non-zero exit to the END of the script. Still fail-closed — the step goes red either way —
  # but the evidence survives the alarm.
  if declare -F assert_grep_clean >/dev/null 2>&1; then
    if ! assert_grep_clean "$outdir" >&2; then
      quarantined=1
      echo "✗ SECRET-BEARING BUNDLE at $outdir — QUARANTINED, recorded, and NOT deleted." >&2
      echo "  Inspect the lines above and rotate anything they name. If they are false positives," >&2
      echo "  the tripwire needs narrowing (see demos/proofs/scrub.sh) — clear the quarantine flag" >&2
      echo "  on the ledger row once reviewed." >&2
    fi
  fi
fi
cat >"$outdir/provision-summary.json" <<EOF
{"feature":"provisioning","cloud":"$cloud","dimension":"$dimension","verdict":"$verdict",
 "quarantined":$([[ -n "${quarantined:-}" ]] && echo true || echo false),
 "git_sha":"$sha","captured_at":"$stamp","detail":$(printf '%s' "${detail:-}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo '""')}
EOF

# The quarantine is carried INTO the ledger detail, not kept beside it — a reader of the log has
# to see that the bundle is pending a secret review without cross-referencing another file.
ledger_detail="${detail:-}"
[[ -n "${quarantined:-}" ]] && ledger_detail="⚠ QUARANTINED (proof-scrub tripwire) — ${ledger_detail:-see bundle}"

# ── on FAIL: file/update a title-deduped GitHub issue (mirror the e2e-nightly rollup filer) ─────
#
# THIS RUNS BEFORE THE LEDGER APPEND, and the order is the fix. It used to run after, so the row
# was written with a hardcoded `—` in its issue column and nothing ever backfilled it: every FAIL
# row in demos/proofs/provisioning-e2e-log.md cites no issue, while the issue it had just filed
# sat one line further down the script. A reader of the ledger — which is the entry point, and what
# PROGRAMME.md derives from — had no way to reach the diagnosis.
#
# `gh issue create` prints the new issue's URL, so the number is the basename. That is the only
# reason this can be resolved before the append rather than after.
issue_ref="—"
if [[ "$verdict" == "FAIL" && -z "${NO_ISSUE:-}" ]] && command -v gh >/dev/null 2>&1; then
  title="e2e: provisioning ${cloud}/${dimension} FAIL"
  existing="$(gh issue list --state open --search "\"$title\" in:title" --json number -q '.[0].number' 2>/dev/null)"
  if [[ -n "$existing" ]]; then
    gh issue comment "$existing" --body "Recurred @ $sha ($stamp) — \`$bundle\`. Last line: ${detail:-see bundle}" >/dev/null 2>&1 || true
    issue_ref="#$existing"
    echo "issue updated: $issue_ref" >&2
  else
    body="$title at \`$sha\` (${stamp}). Proof bundle: \`$bundle\`. Last line: ${detail:-see bundle}. Auto-filed by provisioning-e2e.sh; re-run to update. Board: docs/testing/provisioning-e2e-parity.md."
    # NOT `|| true` with a success message after it. The old form printed "issue filed" whether or
    # not the call worked — a rate limit, a missing label or no token all reported success, and the
    # ledger row said `—` either way, so nothing anywhere recorded that the filing had been lost.
    # A run whose evidence cannot be reached is the failure this file exists to prevent.
    if issue_url="$(gh issue create --title "$title" --label "lane:tests" --body "$body" 2>/dev/null)"; then
      issue_ref="#${issue_url##*/}"
      echo "issue filed: $issue_ref $title" >&2
    else
      echo "::warning::could not file the tracking issue for ${cloud}/${dimension} — the ledger row will cite none. Bundle: ${bundle}" >&2
    fi
  fi
fi

append_ledger "$sha" "$verdict" "$ledger_detail" "$bundle" "$issue_ref"

# A quarantined bundle fails the step even on a PASS verdict — the record is written, but the run
# is not clean until a human clears the tripwire hit.
[[ "$verdict" == "PASS" && -z "${quarantined:-}" ]]
