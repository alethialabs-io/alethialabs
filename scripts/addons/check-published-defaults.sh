#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Fails when an add-on ships a credential that its upstream chart also publishes as a default.
#
# WHY THIS EXISTS
#
# Two add-ons shipped from the marketplace with the credentials printed in their own chart's
# values.yaml on GitHub — harbor with `Harbor12345` and `not-a-secure-key` (the key it encrypts data
# at rest with), kube-prometheus-stack with Grafana's `prom-operator` (#2846). Nobody noticed,
# because EVERY signal we have for "this add-on's credentials are wrong" is a DIFF:
#
#   * ArgoCD reports Synced — the manifest matches the cluster, and it does.
#   * The Application reports Healthy — the workload is up, and it is.
#   * check-render-determinism.sh compares two renders of the same chart, and a CONSTANT is
#     identical in both, so it agrees with itself.
#
# The rotating variants of the same class (#2822, #2823) were noisy and were found in a day. The
# still ones shipped.
#
# THE RULE, AND WHY IT NEEDS NO DENYLIST
#
# A credential our render produces AND the upstream chart publishes is BY DEFINITION not a secret.
# So the reference is not a maintained list of weak passwords — it is the chart itself, rendered at
# its own defaults. Anything appearing in both is public knowledge.
#
# That matters because a hand-kept denylist misses what it did not think of. The first sweep of this
# class was a regex over known-weak values, and it missed `harbor_registry_password` — a genuine
# published default that simply does not look like one.
#
# THE ALLOWLIST IS A RATCHET
#
# Not every shared value is a credential: a chart's default admin USERNAME is `admin` on purpose and
# leaking it leaks nothing. `published-defaults-allowed.txt` records those, each with a reason. The
# check fails if
#   * a shared value is NOT declared (a new one shipped), OR
#   * a declared one no longer appears (fixed — remove it, so the list only shrinks), OR
#   * a chart fails to render, OR
#   * the fixture yields no add-ons.
#
#   * OR an add-on's render contains Secret documents from which nothing decoded — the extraction
#     has stopped matching, so that add-on was not checked at all.
#
# The last three matter as much as the first: a sweep whose "found nothing" branch is
# indistinguishable from its "nothing is wrong" branch is the defect class this repo keeps paying
# for, and an extractor that silently stops matching is the cheapest way to build one.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$repo_root/test/e2e/fixtures/addon_catalog.json"
allowfile="$repo_root/scripts/addons/published-defaults-allowed.txt"

command -v helm >/dev/null 2>&1 || { echo "check-published-defaults: helm is not installed" >&2; exit 2; }
[ -r "$fixture" ] || { echo "check-published-defaults: no fixture at $fixture" >&2; exit 2; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# shellcheck disable=SC2016  # the ${...} below are JS template literals, not shell expansions
node -e '
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const specs = Array.isArray(raw) ? raw : (raw.addons || raw.specs || Object.values(raw)[0]);
if (!Array.isArray(specs)) throw new Error("fixture is not a list of install specs");
const dir = process.argv[2];
const lines = [];
for (const s of specs) {
  if (!s.id || !s.chart || !s.chartRepo || !s.version) {
    throw new Error(`add-on ${s.id ?? "<unnamed>"} is missing chart coordinates`);
  }
  fs.writeFileSync(`${dir}/${s.id}.values.json`, JSON.stringify(s.values ?? {}));
  lines.push([s.id, s.chartRepo, s.chart, s.version, s.namespace || s.id].join(" "));
}
fs.writeFileSync(`${dir}/charts.txt`, lines.join("\n") + "\n");
' "$fixture" "$workdir"

total="$(grep -c '[^[:space:]]' "$workdir/charts.txt" || true)"
if [ "$total" -eq 0 ]; then
  echo "check-published-defaults: the fixture yielded ZERO add-ons — nothing was checked" >&2
  exit 2
fi

declared=""
if [ -r "$allowfile" ]; then
  declared="$(sed -e 's/#.*//' "$allowfile" | grep -v '^[[:space:]]*$' | sed 's/[[:space:]]*$//' || true)"
fi
is_declared() { printf '%s\n' "$declared" | grep -qxF "$1"; }

# The set of add-ons this method CANNOT reach is itself ratcheted (#2853 review). Otherwise a third
# chart becoming un-renderable at its defaults would quietly drop coverage from 16 to 15 on a run
# that still printed OK — the number of add-ons actually checked would fall with nothing to say so.
uncheckfile="$repo_root/scripts/addons/published-defaults-uncheckable.txt"
uncheckable=""
if [ -r "$uncheckfile" ]; then
  uncheckable="$(sed -e 's/#.*//' "$uncheckfile" | grep -v '^[[:space:]]*$' | sed 's/[[:space:]]*$//' || true)"
fi
is_uncheckable() { printf '%s\n' "$uncheckable" | grep -qxF "$1"; }

while read -r id repo chart version ns; do
  [ -n "$id" ] || continue
  helm repo add "pd-$id" "$repo" >/dev/null 2>&1 || true
done < "$workdir/charts.txt"
helm repo update >/dev/null 2>&1 || true

undeclared=""
stale=""
failed=""
unreadable=""
uncomparable=""
new_uncheckable=""
now_checkable=""
seen_file="$workdir/seen.txt"
: > "$seen_file"

while read -r id repo chart version ns; do
  [ -n "$id" ] || continue

  # OURS: the chart as the runner would install it. THEIRS: the same chart at its own defaults —
  # the published reference, which is why no maintained list of bad values is needed.
  helm template "addon-$id" "pd-$id/$chart" --version "$version" -n "$ns" \
    --values "$workdir/$id.values.json" --kube-version 1.30.0 \
    > "$workdir/$id.ours.yaml" 2> "$workdir/$id.err" || true
  helm template "addon-$id" "pd-$id/$chart" --version "$version" -n "$ns" \
    --kube-version 1.30.0 > "$workdir/$id.theirs.yaml" 2>> "$workdir/$id.err" || true

  if [ ! -s "$workdir/$id.ours.yaml" ]; then
    failed="$failed $id"
    echo "RENDER FAILED  $id — $(head -1 "$workdir/$id.err" | cut -c1-110)"
    continue
  fi
  if [ ! -s "$workdir/$id.theirs.yaml" ]; then
    # A chart that REQUIRES values cannot be rendered at its own defaults, so there is no published
    # reference to compare against. loki and opentelemetry-collector are both like this. That is a
    # real limit of this method rather than a fault, and it is reported as "not checked" — the one
    # thing it must never do is print `clean`.
    uncomparable="$uncomparable $id"
    if is_uncheckable "$id"; then
      echo "NOT CHECKED    $id — declared: cannot render at its own defaults"
    else
      new_uncheckable="$new_uncheckable $id"
      echo "NEWLY UNCHECKABLE  $id — the chart cannot render at its own defaults, so there is no"
      echo "                   published reference: $(head -1 "$workdir/$id.err" | cut -c1-84)"
    fi
    continue
  fi

  hits="$(ADDON_ID="$id" python3 - "$workdir/$id.ours.yaml" "$workdir/$id.theirs.yaml" <<'PY'
import base64, os, re, sys

def secret_values(path):
    """decoded value -> set of data keys, across every Secret in the document.

    Returns (values, decoded_any). `decoded_any` counts every entry that base64-decoded, BEFORE the
    length filter — it answers "can this scan still read this chart", which is a different question
    from "did anything survive as a credential candidate".
    """
    found, in_secret, decoded_any = {}, False, 0
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("kind: Secret"):
            in_secret = True
        elif line.startswith("kind: ") or line.startswith("---"):
            in_secret = False
        m = re.match(r'^  ([A-Za-z0-9_.\-]+): "?([A-Za-z0-9+/=]{4,})"?\s*$', line)
        if in_secret and m:
            try:
                dec = base64.b64decode(m.group(2)).decode("utf-8", "strict")
            except Exception:
                continue
            decoded_any += 1
            # Long values are certificates, keys and embedded config files — not shipped credential
            # constants, and a value we generate would not match theirs anyway. Note this filter is
            # applied AFTER counting: a value excluded here was read perfectly well.
            if 0 < len(dec) <= 128:
                found.setdefault(dec, set()).add(m.group(1))
    return found, decoded_any

# Metadata keys that live at the same indent as data entries and are not data.
_META = re.compile(r"^  (name|namespace|labels|annotations|type|apiVersion|kind|data|stringData):")

def candidate_data_lines(path):
    """Lines inside a Secret that LOOK like a data entry, decoded or not.

    This is what separates "the Secret is empty" from "the Secret has entries this scan can no
    longer read". trivy-operator and velero both render a Secret with an empty `data:` block, so
    zero decoded values is the correct and complete answer for them — treating that as a broken
    extractor would cry wolf on two add-ons that are genuinely fine.
    """
    n, in_secret = 0, False
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("kind: Secret"):
            in_secret = True
        elif line.startswith("kind: ") or line.startswith("---"):
            in_secret = False
        if in_secret and re.match(r"^  [A-Za-z0-9_.\-]+: \S", line) and not _META.match(line):
            n += 1
    return n

ours, ours_decoded = secret_values(sys.argv[1])
theirs, _ = secret_values(sys.argv[2])
addon = os.environ["ADDON_ID"]

# EXTRACTION-BROKE detector. Data-shaped lines that yield NO decoded values mean the shape moved
# underneath this scan — a restructured chart, a stringData block, an apiVersion change — and a
# comparison over an empty set passes cleanly while checking nothing. "found nothing" and "nothing
# is wrong" must not render the same, so this is a hard error rather than a silent clean pass.
#
# Keyed on candidate LINES rather than on Secret documents, because a Secret with an empty `data:`
# block is legitimately empty: trivy-operator and velero both render one, and the first version of
# this check called them broken.
# Keyed on whether anything DECODED, not on whether anything survived the length filter. A chart
# whose only Secret holds one long embedded config — kube-prometheus-stack, once Grafana reads its
# admin credential from a runner-seeded Secret and stops rendering its own — decodes fine and
# legitimately yields no credential candidates. Reporting that as a broken extractor is a false
# alarm on a chart that is working exactly as intended.
if candidate_data_lines(sys.argv[1]) > 0 and ours_decoded == 0:
    print(f"{addon}\t!EXTRACTION-YIELDED-NOTHING")
    sys.exit(0)

for value in sorted(set(ours) & set(theirs)):
    for key in sorted(ours[value]):
        print(f"{addon}\t{key}")
PY
)"

  if [ -z "$hits" ]; then
    echo "clean          $id"
    continue
  fi

  if printf '%s' "$hits" | grep -q '!EXTRACTION-YIELDED-NOTHING'; then
    unreadable="$unreadable $id"
    echo "EXTRACTION BROKE  $id — the render contains Secret documents but none decoded."
    echo "                  The scan cannot see this chart any more; it has NOT been checked."
    continue
  fi

  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    entry="$(printf '%s' "$hit" | tr '\t' '.')"
    printf '%s\n' "$entry" >> "$seen_file"
    if is_declared "$entry"; then
      echo "known default  $entry — declared"
    else
      undeclared="$undeclared $entry"
      # The VALUE is deliberately not printed. It is public, but a build log is not the place to
      # republish it, and the key name is what someone needs in order to act.
      echo "PUBLISHED DEFAULT  $entry — this value is also what the upstream chart ships"
    fi
  done <<< "$hits"
done < "$workdir/charts.txt"

# Ratchet the other way: a declared entry that no longer appears has been fixed and must go, so the
# list can never quietly grow back.
if [ -n "$declared" ]; then
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    if ! grep -qxF "$entry" "$seen_file" 2>/dev/null; then
      stale="$stale $entry"
      echo "NO LONGER SHIPPED  $entry — remove it from $(basename "$allowfile")"
    fi
  done <<< "$declared"
fi

echo
echo "checked $total add-on(s)"

# And the other direction: a declared-uncheckable add-on that now renders is coverage REGAINED, and
# the list must shrink to record it.
if [ -n "$uncheckable" ]; then
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case " $uncomparable " in
      *" $entry "*) ;;
      *) now_checkable="$now_checkable $entry"
         echo "NOW CHECKABLE  $entry — it renders at its defaults again; remove it from $(basename "$uncheckfile")" ;;
    esac
  done <<< "$uncheckable"
fi

status=0
if [ -n "$uncomparable" ]; then
  # Reported loudly and NOT a failure: these add-ons cannot be checked by this method at all, and
  # pretending otherwise in either direction would be worse than saying so. Counting them as clean
  # would be the silent-pass bug; failing on them would make the check unpassable.
  echo "NOT CHECKED (no default render available):$uncomparable" >&2
fi
if [ -n "$new_uncheckable" ]; then
  echo "FAIL: add-on(s) newly cannot be checked:$new_uncheckable" >&2
  echo "      Coverage SHRANK. Declare them in $(basename "$uncheckfile") with the reason, so the" >&2
  echo "      set this method cannot reach is a recorded decision rather than a drifting number." >&2
  status=1
fi
if [ -n "$now_checkable" ]; then
  echo "FAIL: declared-uncheckable add-on(s) now render:$now_checkable" >&2
  echo "      Coverage grew — drop them so the list can only shrink." >&2
  status=1
fi
if [ -n "$failed" ]; then
  echo "FAIL: chart(s) did not render at all:$failed" >&2
  status=1
fi
if [ -n "$unreadable" ]; then
  # A DIFFERENT failure from a render failure, and it used to share that message — which sent me
  # looking for a broken chart when the chart rendered perfectly.
  echo "FAIL: chart(s) rendered but this scan could not read their Secrets:$unreadable" >&2
  echo "      The extraction has stopped matching; those add-ons were NOT checked." >&2
  status=1
fi
if [ -n "$undeclared" ]; then
  echo "FAIL: add-on(s) ship a credential their upstream chart publishes:$undeclared" >&2
  echo "      Mint it instead (AddOnDef.generateSecrets, #2827) and point the chart at the" >&2
  echo "      runner-seeded Secret, or declare it in $(basename "$allowfile") with a reason." >&2
  status=1
fi
if [ -n "$stale" ]; then
  echo "FAIL: declared default(s) no longer shipped:$stale" >&2
  echo "      The list is a ratchet — drop these so it cannot silently grow back." >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "OK — no add-on ships a credential its upstream chart publishes"
exit "$status"
