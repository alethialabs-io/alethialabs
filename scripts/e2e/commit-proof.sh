#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Commit a nightly leg's proof: the scrubbed bundle INTO the tree, and its ledger row rewritten to
# point at that committed path.
#
# WHY THIS EXISTS. The rollup ends with `appended provisioning-e2e ledger rows — upload for a
# maintainer to commit`, and the row it writes references the ARTIFACT name
# (`e2e-proof-<cloud>-<run>`). An artifact expires. PROGRAMME.md only counts a cell proven when the
# ledger's surviving claim is PASS *and* its bundle is a committed path that EXISTS — which is
# exactly the rule every 2026-07-22 row was retracted for breaking. Doing this by hand, once per
# cell, twenty-four times, is how a row keeps that artifact reference and silently proves nothing.
#
# Usage: scripts/e2e/commit-proof.sh <run_id> <cloud>
#
# Run it once PER CLOUD of a multi-cloud nightly: each call commits that leg's bundle, carries its
# post-teardown verification receipt into it when the run has one, and appends that leg's row.
#
# It is deliberately NOT idempotent-by-guessing: every ambiguity (no bundle carrying this run's
# run_tag, more than one, no row naming this leg's artifact, more than one, a bundle or row already
# in the tree) is a hard error, because each one means the run did not have the shape this script
# assumes and a silent choice would put a wrong claim in the ledger.
set -euo pipefail

run_id="${1:?usage: commit-proof.sh <run_id> <cloud>}"
cloud="${2:?usage: commit-proof.sh <run_id> <cloud>}"
repo="${ALETHIA_REPO:-alethialabs-io/alethialabs}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ledger="$root/demos/proofs/provisioning-e2e-log.md"
dest="$root/demos/proofs/$cloud"

command -v gh >/dev/null || { echo "commit-proof: gh is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "commit-proof: jq is required" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

art_json="$(gh api "repos/$repo/actions/runs/$run_id/artifacts" --paginate)"
id_for() { printf '%s' "$art_json" | jq -r --arg n "$1" '.artifacts[] | select(.name==$n) | .id' | head -1; }

proof_id="$(id_for "e2e-proof-${cloud}-${run_id}")"
ledger_id="$(id_for "provisioning-e2e-log-${run_id}")"
teardown_id="$(id_for "e2e-teardown-verify-${cloud}-${run_id}")"
[ -n "$proof_id" ]  || { echo "commit-proof: no artifact e2e-proof-${cloud}-${run_id} on run $run_id" >&2; exit 1; }
[ -n "$ledger_id" ] || { echo "commit-proof: no artifact provisioning-e2e-log-${run_id} on run $run_id" >&2; exit 1; }

gh api "repos/$repo/actions/artifacts/$proof_id/zip"  > "$tmp/proof.zip"
gh api "repos/$repo/actions/artifacts/$ledger_id/zip" > "$tmp/ledger.zip"
unzip -oq "$tmp/proof.zip"  -d "$tmp/proof"
unzip -oq "$tmp/ledger.zip" -d "$tmp/ledger"

# ── WHICH BUNDLE IS THIS RUN'S. Asked of the PAYLOAD (`run_tag`), never of where a path says it is —
#    the same contract e2e-nightly.yml's `Resolve this run's proof bundle` step and nightly-rollup.sh
#    discover on (#1613).
#
#    The artifact has had TWO layouts, and this script must read both:
#      - before #4766 (2026-09-18) the upload named the tracked provider DIRECTORY, so the artifact
#        held `<stamp>/…` subdirectories — this run's bundle plus every historical one in the checkout;
#      - since #4766 it names this run's bundle directory itself, so upload-artifact roots the zip AT
#        it: the bundle's files sit at the top level and the `<stamp>` directory name is gone.
#    The old loop here only knew the first layout. On the second it globbed zero subdirectories,
#    bash left the pattern literal, and `*` was counted as the one new bundle — every nightly after
#    #4766 went unrecorded because the ledger-row check below happened to refuse first.
#
#    On the flat layout the stamp is recovered from the bundle's own `captured_at`, which
#    capture-proof.sh writes from the SAME variable it names the directory with.
run_tag_prefix="nightly-${run_id}-"
candidates=()
[ -f "$tmp/proof/provision-summary.json" ] && candidates+=("$tmp/proof")
for d in "$tmp/proof"/*/; do
  [ -f "${d}provision-summary.json" ] && candidates+=("${d%/}")
done
mine=()
for d in "${candidates[@]}"; do
  case "$(jq -r '.run_tag // empty' "$d/provision-summary.json" 2>/dev/null)" in
    "$run_tag_prefix"*) mine+=("$d") ;;
  esac
done
[ "${#mine[@]}" -eq 1 ] || {
  echo "commit-proof: expected exactly ONE bundle in e2e-proof-${cloud}-${run_id} carrying run_tag ${run_tag_prefix}<attempt>, found ${#mine[@]}" >&2
  echo "  (none = the leg captured nothing publishable — a CAPTURE-ABORTED marker, or a gate-off; more than one = the run_tag is not unique and picking one would be a guess)" >&2
  exit 1
}
src="${mine[0]}"
if [ "$src" = "$tmp/proof" ]; then
  stamp="$(jq -r '.captured_at // empty' "$src/provision-summary.json")"
else
  stamp="$(basename "$src")"
fi
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
  echo "commit-proof: bundle stamp '${stamp}' is not a UTC stamp (YYYYMMDDTHHMMSSZ) — refusing to invent a directory name" >&2
  exit 1
}
mkdir -p "$dest"
[ ! -e "$dest/$stamp" ] || {
  echo "commit-proof: demos/proofs/$cloud/$stamp already exists — this proof is already committed" >&2
  exit 1
}

# ── WHICH LEDGER ROW IS THIS LEG'S. A multi-cloud nightly appends one row PER LEG to the one ledger
#    file, so "exactly one added row" (the old rule) refused every run with more than one cloud —
#    and recording a second cloud from the same run would see the first cloud's rewritten row as a
#    change too. The row is instead selected by the one thing that identifies it: its bundle column
#    names THIS leg's artifact. Exactly one, or refuse.
artifact_ref="\`e2e-proof-${cloud}-${run_id}\`"
mapfile -t added < <(grep -F -- "$artifact_ref" "$tmp/ledger/provisioning-e2e-log.md" || true)
[ "${#added[@]}" -eq 1 ] || {
  echo "commit-proof: expected exactly ONE ledger row naming ${artifact_ref} in provisioning-e2e-log-${run_id}, found ${#added[@]}" >&2
  printf '  %s\n' "${added[@]:-}" >&2
  exit 1
}
row="${added[0]}"
row_cloud="$(printf '%s' "$row" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $4); print $4}')"
[ "$row_cloud" = "$cloud" ] || {
  echo "commit-proof: the row naming ${artifact_ref} is for cloud '${row_cloud}', not '${cloud}' — refusing:" >&2
  echo "  $row" >&2; exit 1
}
if grep -qF -- "$row" "$ledger"; then
  echo "commit-proof: that exact row is already in the ledger — refusing to append it twice" >&2
  exit 1
fi

# The rewrite this whole script exists for.
committed_ref="\`demos/proofs/${cloud}/${stamp}\`"
# (The row was SELECTED by containing the artifact reference, so it always has one to rewrite.)
row="${row//$artifact_ref/$committed_ref}"

# ── INTEGRITY GATE (#3281). The ledger row and the committed path are what PROGRAMME.md counts,
#    and neither looks inside the bundle. A hetzner/addons run that drove 22 Applications to
#    Healthy+Synced shipped a bundle recording `argocd_assert_outcome: unmeasured`, and the cell
#    went green on a job-log line that expires. So the claim is checked HERE, at the moment the
#    bundle is used to make one — never at capture time, where refusing would destroy the evidence
#    of a failing run.
#
#    The dimension comes from the ROW being appended (column 5), not from a guess: the row is the
#    thing making the claim, so it is the thing that must be judged.
dimension="$(printf '%s' "$row" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $5); print $5}')"
[ -n "$dimension" ] || {
  echo "commit-proof: could not read the dimension out of the ledger row — refusing to promote a claim I cannot judge:" >&2
  echo "  $row" >&2; exit 1
}
integrity_reason=""
if ! integrity_out="$(bash "$root/demos/proofs/check-proof-integrity.sh" "$src" --dimension "$dimension" 2>&1)"; then
  if [ -z "${ALETHIA_ACCEPT_UNMEASURED:-}" ]; then
    echo "$integrity_out" >&2
    echo "commit-proof: REFUSING to commit demos/proofs/$cloud/$stamp as a '$dimension' proof." >&2
    exit 1
  fi
  # The override is not a way to make the problem quiet. It goes in the ledger's notes column, so
  # the row says what it rests on and a later reader can find the run that DOES carry the counts.
  integrity_reason="$ALETHIA_ACCEPT_UNMEASURED"
  echo "commit-proof: integrity check overridden — recording the reason in the row:" >&2
  echo "  $integrity_reason" >&2
else
  echo "commit-proof: $integrity_out"
fi

if [ -n "$integrity_reason" ]; then
  # Replace the trailing notes cell (`| — |`) rather than appending a column, so the table shape
  # is unchanged. A row that already carries a note is left alone rather than silently overwritten.
  case "$row" in
    *"| — |") row="${row%| — |}| ⚠️ argocd counts unmeasured: ${integrity_reason} |" ;;
    *) echo "commit-proof: the row already carries a note; not overwriting it. Add the override reason by hand:" >&2
       echo "  $integrity_reason" >&2 ;;
  esac
fi

mkdir -p "$dest/$stamp"
cp -R "$src"/. "$dest/$stamp"/

# ── TEARDOWN EVIDENCE. The post-teardown verification receipt (#4398) is a SEPARATE artifact, and
#    like every artifact it expires in 30 days. Carried verbatim into the bundle it becomes the only
#    durable record of whether this run left anything behind. It is not a gate on the row — the
#    row claims provisioning, and a measured leak is filed by the rollup as its own issue — so a
#    missing or non-CLEAN receipt is REPORTED, never hidden and never refused.
if [ -n "$teardown_id" ]; then
  gh api "repos/$repo/actions/artifacts/$teardown_id/zip" > "$tmp/teardown.zip"
  unzip -oq "$tmp/teardown.zip" -d "$tmp/teardown"
  if [ -f "$tmp/teardown/teardown-verify.json" ]; then
    cp "$tmp/teardown/teardown-verify.json" "$dest/$stamp/teardown-verify.json"
    echo "commit-proof: teardown-verify: $(jq -r '"\(.verdict) — \(.reason); unverifiable=\(.unverifiable|length) unattributable=\(.unattributable|join(",") | if .=="" then "none" else . end)"' "$dest/$stamp/teardown-verify.json")"
  else
    echo "commit-proof: WARNING: e2e-teardown-verify-${cloud}-${run_id} holds no teardown-verify.json — teardown is NOT verified for this bundle" >&2
  fi
else
  echo "commit-proof: WARNING: no e2e-teardown-verify-${cloud}-${run_id} artifact — teardown is NOT verified for this bundle" >&2
fi

printf '%s\n' "$row" >> "$ledger"

echo "commit-proof: committed demos/proofs/$cloud/$stamp and appended its row."
echo "  next: pnpm gen:programme && open a PR into dev"
