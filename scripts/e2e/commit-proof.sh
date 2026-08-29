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
# It is deliberately NOT idempotent-by-guessing: every ambiguity (no new bundle, more than one new
# bundle, more than one new ledger row) is a hard error, because each one means the run did not have
# the shape this script assumes and a silent choice would put a wrong claim in the ledger.
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
[ -n "$proof_id" ]  || { echo "commit-proof: no artifact e2e-proof-${cloud}-${run_id} on run $run_id" >&2; exit 1; }
[ -n "$ledger_id" ] || { echo "commit-proof: no artifact provisioning-e2e-log-${run_id} on run $run_id" >&2; exit 1; }

gh api "repos/$repo/actions/artifacts/$proof_id/zip"  > "$tmp/proof.zip"
gh api "repos/$repo/actions/artifacts/$ledger_id/zip" > "$tmp/ledger.zip"
unzip -oq "$tmp/proof.zip"  -d "$tmp/proof"
unzip -oq "$tmp/ledger.zip" -d "$tmp/ledger"

# The NEW bundle is whichever stamp directory the tree does not already carry. Comparing against the
# tree rather than picking "the newest" matters: the artifact holds every bundle that was in the
# checkout at capture time, so "newest" would happily re-commit one that is already here.
mkdir -p "$dest"
new_bundles=()
for d in "$tmp/proof"/*/; do
  stamp="$(basename "$d")"
  [ -e "$dest/$stamp" ] || new_bundles+=("$stamp")
done
[ "${#new_bundles[@]}" -eq 1 ] || {
  echo "commit-proof: expected exactly ONE new bundle under demos/proofs/$cloud, found ${#new_bundles[@]}: ${new_bundles[*]:-none}" >&2
  echo "  (none = this proof is already committed; more than one = commit them one run at a time)" >&2
  exit 1
}
stamp="${new_bundles[0]}"

# Exactly one row must be ADDED. A leg that recorded nothing, or a ledger that moved underneath us,
# both land here rather than in the ledger.
mapfile -t added < <(diff "$ledger" "$tmp/ledger/provisioning-e2e-log.md" | sed -n 's/^> //p')
[ "${#added[@]}" -eq 1 ] || {
  echo "commit-proof: expected exactly ONE new ledger row, found ${#added[@]}" >&2
  printf '  %s\n' "${added[@]:-}" >&2
  exit 1
}
row="${added[0]}"

# The rewrite this whole script exists for.
artifact_ref="\`e2e-proof-${cloud}-${run_id}\`"
committed_ref="\`demos/proofs/${cloud}/${stamp}\`"
case "$row" in
  *"$artifact_ref"*) row="${row//$artifact_ref/$committed_ref}" ;;
  *"demos/proofs/"*) echo "commit-proof: row already references a committed path; leaving it alone" >&2 ;;
  *) echo "commit-proof: row references neither the artifact nor a committed path — refusing to guess:" >&2
     echo "  $row" >&2; exit 1 ;;
esac

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
if ! integrity_out="$(bash "$root/demos/proofs/check-proof-integrity.sh" "$tmp/proof/$stamp" --dimension "$dimension" 2>&1)"; then
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

cp -R "$tmp/proof/$stamp" "$dest/$stamp"
printf '%s\n' "$row" >> "$ledger"

echo "commit-proof: committed demos/proofs/$cloud/$stamp and appended its row."
echo "  next: pnpm gen:programme && open a PR into dev"
