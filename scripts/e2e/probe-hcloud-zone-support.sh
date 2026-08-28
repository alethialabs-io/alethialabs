#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# THE EXPERIMENT THAT SEPARATES DEPTH FROM TLD in Hetzner Cloud DNS's zone refusals (#2843).
#
# apps/console/lib/cloud-providers/dns-zone-support.ts gates a deploy on which zone names Hetzner
# will host. The five observations it carries are consistent with a depth rule, a TLD rule, or both,
# because every probe varied the two TOGETHER — every accepted name was two labels and every refused
# one was three or four. The gate therefore refuses on the half that is monotone in the data (depth,
# under a gTLD) and keeps the `.io` denial marked unconfirmed. This script closes that.
#
# THE CELLS, AND WHAT EACH ONE DECIDES:
#
#   alethia-probe-<r>.com        2 labels, gTLD    control — anything else means the probe is broken
#   alethia-probe-<r>.io         2 labels, gTLD    IS .io DENIED AT ALL? never once tested at depth 2
#   sub.alethia-probe-<r>.com    3 labels, gTLD    is depth refused on an ACCEPTED TLD?
#   a.b.alethia-probe-<r>.com    4 labels, gTLD    consistency with run 32984975119
#   alethia-probe-<r>.co.uk      3 labels, ccTLD   DOES A MULTI-PART PUBLIC SUFFIX WORK AT 3 LABELS?
#
# The last is the one that decides whether the gate's country-code carve-out is a real exemption or
# an unnecessary hole. The second decides whether the `.io` denylist should exist at all — and if
# .io is accepted at two labels, that entry is refusing domains that would have worked, which the
# module's own header calls worse than the gap it closes.
#
# WHY IT IS A SCRIPT IN CI RATHER THAN SOMETHING RUN BY HAND. The only hcloud contexts on a
# maintainer laptop are PRODUCTION, which is why #2843 deliberately left this unmeasured rather than
# probing from one. The e2e project's HCLOUD_TOKEN lives in Actions, so the probe belongs there.
#
# SAFETY, WHICH IS THE WHOLE REASON THIS IS NOT A ONE-LINER:
#
#   · It only ever creates names matching its own generated prefix, which carries a run id.
#   · It deletes by the ID THE CREATE RETURNED. It never lists zones and never deletes by name, so
#     it has no way to reach a zone it did not make — including one that happens to share a name.
#   · Cleanup runs on EXIT, so an interrupted probe still tears down what it made.
#   · It refuses to run against a token it was not given explicitly.
#   · A zone with no NS delegation resolves nothing for anybody. These names are not delegated to
#     Hetzner, so creating them changes nothing in the public DNS; the domains are also not ours,
#     which is exactly why they are safe to try and pointless to keep.
#
# Cost: zero. Hetzner Cloud DNS bills per zone-month with a free allowance, and these live seconds.

set -uo pipefail

API="https://api.hetzner.cloud/v1"
token="${HCLOUD_TOKEN:-}"
if [ -z "$token" ]; then
  echo "::error title=no token::HCLOUD_TOKEN is unset. This probe talks to the live Hetzner API and will not guess at a credential." >&2
  exit 2
fi

run_id="${GITHUB_RUN_ID:-${PROBE_RUN_ID:-manual}}"
base="alethia-probe-${run_id}"

created_ids=()
cleanup() {
  local rc=$?
  if [ ${#created_ids[@]} -gt 0 ]; then
    echo "→ deleting ${#created_ids[@]} probe zone(s) by the id each create returned" >&2
    for id in "${created_ids[@]}"; do
      code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer ${token}" "${API}/zones/${id}")"
      # A delete that does not confirm is the one thing here that leaves something behind, so it is
      # reported per zone rather than summarised — a silent partial cleanup is how a probe becomes
      # an orphan.
      case "$code" in
        200 | 204) echo "   deleted zone ${id}" >&2 ;;
        *) echo "::warning title=probe zone NOT deleted::zone ${id} returned HTTP ${code} on delete — remove it by hand." >&2 ;;
      esac
    done
  fi
  exit "$rc"
}
trap cleanup EXIT

# name → the API's verdict. Records the zone id on success so cleanup can reach it.
probe() {
  local name="$1" note="$2"
  local body code out
  out="$(curl -sS -w '\n%{http_code}' -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" \
    -d "{\"name\":\"${name}\",\"ttl\":3600}" "${API}/zones")"
  code="$(printf '%s' "$out" | tail -n1)"
  body="$(printf '%s' "$out" | sed '$d')"

  local labels verdict detail
  labels="$(printf '%s' "$name" | tr '.' '\n' | grep -c .)"
  if [ "$code" = "201" ] || [ "$code" = "200" ]; then
    local id
    id="$(printf '%s' "$body" | sed -n 's/.*"zone":{"id":\([0-9]*\).*/\1/p')"
    [ -n "$id" ] && created_ids+=("$id")
    verdict="CREATED"
    detail="id ${id:-unknown}"
  else
    verdict="REFUSED"
    # The message is the interesting part: Hetzner says "unsupported tld" for names that are not
    # about a TLD at all, which is the confusion this whole issue is about.
    detail="HTTP ${code} · $(printf '%s' "$body" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | head -1)"
  fi
  printf '| `%s` | %s | %s | **%s** | %s |\n' "$name" "$labels" "${name##*.}" "$verdict" "$detail"
}

echo "# Hetzner Cloud DNS — which zone names does it accept? (#2843)"
echo
echo "| name | labels | tld | verdict | detail |"
echo "|---|---|---|---|---|"
probe "${base}.com" "control"
probe "${base}.io" "is .io denied at two labels?"
probe "sub.${base}.com" "is depth refused on an accepted TLD?"
probe "a.b.${base}.com" "consistency with run 32984975119"
probe "${base}.co.uk" "does a multi-part public suffix work at three labels?"
echo
cat <<'EOF'
## How to read it

- **`.io` CREATED at two labels** → the TLD denylist in `dns-zone-support.ts` is refusing domains
  that would have worked. Delete the `denied` entry; depth was the whole story.
- **`.io` REFUSED at two labels** → the denylist is real and independently confirmed for the first
  time. Say so in the module and drop the "not yet confirmed on its own" hedge from the message.
- **`sub.…com` REFUSED** → the depth rule is measured rather than inferred.
- **`…co.uk` CREATED** → the country-code carve-out is a real exemption, and a public suffix list
  would be needed to close the gap it leaves.
- **`…co.uk` REFUSED** → the carve-out is an unnecessary hole: Hetzner wants two labels flat, and the
  rule can drop the ccTLD exception and catch `shop.example.co.uk` too.

Whatever it says, update `apps/console/lib/cloud-providers/dns-zone-support.ts` — its header names
this script — and the expectations in `dns-zone-support.test.ts` that pin the deliberate gap.
EOF
