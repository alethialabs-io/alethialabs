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
# The keyless epic has had no ledger at all, which is why a path that had never authenticated to a
# real database could look shipped for months (#1500). An empty ledger is a legible answer; a green
# board with no runs behind it is not.
#
# A SKIPPED test is classified BLOCKED, never PASS. That is the mistake that let four clouds'
# green-skips read as proofs on the provisioning board (#1723).
#
# The caller exports the target env (see docs/testing/e2e-nightly-enablement.md):
#   ALETHIA_E2E_KEYLESS_DB=1 ALETHIA_E2E_KEYLESS_DB_{ENGINE,NAME,NAMESPACE,SERVICE,IMAGE,...}
#   plus the provider creds the base T2 proof needs.
#
# Env knobs: NO_ISSUE=1 (don't file a GH issue on fail) · BLOCKED="<reason>" (force a BLOCKED record).
set -uo pipefail

cloud="${1:?usage: keyless-db-e2e.sh <aws|gcp|azure> <postgres|mysql>}"
engine="${2:?usage: keyless-db-e2e.sh <aws|gcp|azure> <postgres|mysql>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
bundle="demos/proofs/keyless/${cloud}-${engine}/${stamp}"
outdir="$root/$bundle"
ledger="$root/demos/proofs/keyless-db-e2e-log.md"
mkdir -p "$outdir"
log="$outdir/run.log"

case "$engine" in postgres|mysql) ;; *) echo "unknown engine $engine" >&2; exit 2 ;; esac

# ── the cell gate. Refuse a cell the PRODUCT excludes, rather than recording a failure against a
#    boundary that is working. The reasons are quoted from manifests.KeylessCell — the same table
#    the canvas shows on the disabled toggle and the parity board carries in full — so this script
#    cannot claim a lane is runnable while the product says it is not.
case "$cloud" in
  aws|gcp|azure) ;;
  alibaba)
    echo "alibaba is a documented EXCLUSION, not a lane: RAM governs ApsaraDB's control plane only" >&2
    echo "— there is no data-plane token login. See docs/testing/keyless-db-parity.md." >&2
    exit 2 ;;
  hetzner)
    echo "hetzner is a documented EXCLUSION, not a lane: Postgres runs in-cluster via CloudNativePG," >&2
    echo "with no managed instance and no cloud identity plane. See docs/testing/keyless-db-parity.md." >&2
    exit 2 ;;
  *) echo "unknown cloud $cloud" >&2; exit 2 ;;
esac

# The REAL test name — never an aspirational one. registry-e2e.sh invoked TestT2XacctRegistry, which
# existed in no file, so it recorded BLOCKED forever; a script that names a test nobody wrote is worse
# than no script. Fixed in #1047, and now guarded by TestScriptRunTargetsResolveToRealTests
# (test/e2e/nightly_reachability_test.go), which fails CI on any unresolvable `-run` target.
run=(go test -tags=e2e_t2 ./... -run "TestT2RealCloudProvisioning" -count=1 -timeout 80m -v)
dir="test/e2e"

# ── run (or record BLOCKED) ──────────────────────────────────────────────────────────────────
if [[ -n "${BLOCKED:-}" ]]; then
  verdict="BLOCKED"; detail="$BLOCKED"
  printf 'BLOCKED: %s\n' "$BLOCKED" | tee "$log" >/dev/null
else
  echo "▶ keyless-db $cloud/$engine @ $sha → $bundle" >&2
  ( cd "$root/$dir" && ALETHIA_E2E_KEYLESS_DB=1 ALETHIA_E2E_KEYLESS_DB_ENGINE="$engine" \
      GOWORK=off "${run[@]}" ) >"$log" 2>&1
  rc=$?
  if [[ $rc -eq 0 ]] && grep -q "^ok\|^--- PASS\|^PASS" "$log"; then verdict="PASS"
  elif grep -q "^--- SKIP\|^ok.*\[no tests to run\]\|SKIP:" "$log" && ! grep -q "FAIL" "$log"; then
    verdict="BLOCKED"; detail="test SKIPPED (env not set)"
  else verdict="FAIL"; fi
  detail="${detail:-$(grep -E "keyless: |FAIL:|Error:|--- (PASS|FAIL)" "$log" | tail -1 | sed 's/|/;/g')}"
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
row="| $(date -u +%Y-%m-%d) | $cloud | $engine | **$verdict** | \`$sha\` | ${detail:-} \`$bundle\` |"
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
  if [[ -n "$existing" ]]; then gh issue comment "$existing" --body "Recurred @ $sha ($stamp) — \`$bundle\`" >/dev/null 2>&1 || true
  else gh issue create --title "$title" --label "wave:hygiene,lane:tests" --body "$body" >/dev/null 2>&1 || true; fi
  echo "issue filed/updated: $title" >&2
fi

[[ "$verdict" == "PASS" ]]
