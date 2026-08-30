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

# A chart we could not REACH is not a chart shipping a bad default (#2754) — see the lib header.
. "$(dirname "${BASH_SOURCE[0]}")/lib/chart-fetch.sh"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Any ONE per-cloud fixture is enough here: the fixtures differ only in external-dns's `provider`
# knob, and what this check reads — chart coordinates and the rendered resource shapes — is identical
# across clouds. hetzner is chosen because it is the harness's own default cloud, so this file and
# addonCatalogFixture() agree on which fixture "the" fixture is.
fixture="$repo_root/test/e2e/fixtures/addon_catalog.hetzner.json"
# ── AND THE DATA-SERVICE SPECS (#3299). ────────────────────────────────────────────────────────
# The marketplace catalogue is not the only place this repo renders a chart. `hetzner-services.ts`
# renders nine more — the in-cluster carriers for the database, cache, queue, registry, secret,
# topic and nosql node KINDS — and Harbor is rendered from BOTH. #2846's fix (stop shipping the
# chart's published `secretKey` and registry password) went to the marketplace copy only, because
# this check has never seen the other one. #3305 extended the render-determinism sweep the same way
# and found two undeclared defects on its first run; this is the same extension on the credential
# question, which is the one that matters more.
ds_fixture="$repo_root/test/e2e/fixtures/hetzner_data_services.json"
allowfile="$repo_root/scripts/addons/published-defaults-allowed.txt"

command -v helm >/dev/null 2>&1 || { echo "check-published-defaults: helm is not installed" >&2; exit 2; }
[ -r "$fixture" ] || { echo "check-published-defaults: no fixture at $fixture" >&2; exit 2; }
[ -r "$ds_fixture" ] || { echo "check-published-defaults: no data-service fixture at $ds_fixture" >&2; exit 2; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# shellcheck disable=SC2016  # the ${...} below are JS template literals, not shell expansions
node -e '
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const specs = Array.isArray(raw) ? raw : (raw.addons || raw.specs || Object.values(raw)[0]);
if (!Array.isArray(specs)) throw new Error("fixture is not a list of install specs");
const dir = process.argv[2];
// The filename key is namespaced by SOURCE; the helm RELEASE NAME stays the id that ships, because
// a chart can derive generated content from it. The two fixtures are independent id spaces — the
// marketplace `vault` is a different release from the data-service `secrets-vault`.
const prefix = process.argv[3];
const lines = [];
for (const s of specs) {
  if (!s.id || !s.chart || !s.chartRepo || !s.version) {
    throw new Error(`spec ${s.id ?? "<unnamed>"} is missing chart coordinates`);
  }
  const key = prefix + s.id;
  fs.writeFileSync(`${dir}/${key}.values.json`, JSON.stringify(s.values ?? {}));
  lines.push([key, s.chartRepo, s.chart, s.version, s.namespace || s.id, s.id].join(" "));
}
fs.appendFileSync(`${dir}/charts.txt`, lines.join("\n") + "\n");
process.stdout.write(String(lines.length));
' "$fixture" "$workdir" "" > "$workdir/n.catalog"

# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const specs = Array.isArray(raw) ? raw : (raw.addons || raw.specs || Object.values(raw)[0]);
if (!Array.isArray(specs)) throw new Error("data-service fixture is not a list of install specs");
const dir = process.argv[2];
const prefix = process.argv[3];
const lines = [];
for (const s of specs) {
  if (!s.id || !s.chart || !s.chartRepo || !s.version) {
    throw new Error(`spec ${s.id ?? "<unnamed>"} is missing chart coordinates`);
  }
  const key = prefix + s.id;
  fs.writeFileSync(`${dir}/${key}.values.json`, JSON.stringify(s.values ?? {}));
  lines.push([key, s.chartRepo, s.chart, s.version, s.namespace || s.id, s.id].join(" "));
}
fs.appendFileSync(`${dir}/charts.txt`, lines.join("\n") + "\n");
process.stdout.write(String(lines.length));
' "$ds_fixture" "$workdir" "hetzner-service." > "$workdir/n.dataservice"

# EACH SOURCE must have yielded something. One combined count would let the data-service half go to
# zero while the total still looked healthy — the "found nothing == nothing wrong" collapse this
# file already guards against for the catalogue alone.
for src in catalog dataservice; do
  n="$(cat "$workdir/n.$src" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -eq 0 ]; then
    echo "check-published-defaults: the $src fixture yielded ZERO specs — that half was not checked" >&2
    exit 2
  fi
done

total="$(grep -c '[^[:space:]]' "$workdir/charts.txt" || true)"
if [ "$total" -eq 0 ]; then
  echo "check-published-defaults: the fixtures yielded ZERO add-ons — nothing was checked" >&2
  exit 2
fi
# Every chart KEY this run knows about, so an allowlist entry can be attributed to its chart. The
# key may contain dots (`hetzner-service.registry-app-images`), so an entry is matched by prefix
# against these rather than split on a separator.
awk '{print $1}' "$workdir/charts.txt" | grep -v '^[[:space:]]*$' > "$workdir/all-keys.txt"

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

while read -r key repo chart version ns id; do
  [ -n "$key" ] || continue
  helm repo add "pd-$key" "$repo" >/dev/null 2>&1 || true
done < "$workdir/charts.txt"
chart_fetch_repo_update "$workdir/repo-update.err" || true

undeclared=""
stale=""
failed=""
unreachable=""
unreadable=""
uncomparable=""
new_uncheckable=""
now_checkable=""
seen_file="$workdir/seen.txt"
: > "$seen_file"
# The charts that were actually RENDERED AND COMPARED. Distinct from the specs the fixtures yielded:
# a chart in $unreachable / $failed / $unreadable / $uncomparable never reached the comparison, so
# nothing of its was ever added to $seen_file — and the stale ratchet below would then read every
# one of its declared entries as "fixed, remove it".
compared_file="$workdir/compared.txt"
: > "$compared_file"

while read -r key repo chart version ns id; do
  [ -n "$key" ] || continue

  # OURS: the chart as the runner would install it. THEIRS: the same chart at its own defaults —
  # the published reference, which is why no maintained list of bad values is needed.
  # Only the FETCH is retried: a chart that downloads and then renders wrongly still fails on
  # the first attempt, so the guard is not weakened. See scripts/addons/lib/chart-fetch.sh.
  render_ours() {
    helm template "addon-$id" "pd-$key/$chart" --version "$version" -n "$ns" \
      --values "$workdir/$key.values.json" --kube-version 1.30.0 \
      > "$workdir/$key.ours.yaml" 2> "$workdir/$key.err" || true
    [ -s "$workdir/$key.ours.yaml" ]
  }
  attempt=1
  while :; do
    render_ours && break
    if [ "$attempt" -ge "$CHART_FETCH_ATTEMPTS" ] || ! chart_fetch_is_net_err "$workdir/$key.err"; then
      break
    fi
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done
  helm template "addon-$id" "pd-$key/$chart" --version "$version" -n "$ns" \
    --kube-version 1.30.0 > "$workdir/$key.theirs.yaml" 2>> "$workdir/$key.err" || true

  if [ ! -s "$workdir/$key.ours.yaml" ]; then
    # #2754: an unreachable host says nothing about the add-on's defaults.
    if chart_fetch_is_net_err "$workdir/$key.err"; then
      unreachable="$unreachable $key"
      echo "COULD NOT FETCH $key — $(chart_fetch_host "$workdir/$key.err") unreachable after ${CHART_FETCH_ATTEMPTS} attempts"
    else
      failed="$failed $key"
      echo "RENDER FAILED  $key — $(head -1 "$workdir/$key.err" | cut -c1-110)"
    fi
    continue
  fi
  if [ ! -s "$workdir/$key.theirs.yaml" ]; then
    # A chart that REQUIRES values cannot be rendered at its own defaults, so there is no published
    # reference to compare against. loki and opentelemetry-collector are both like this. That is a
    # real limit of this method rather than a fault, and it is reported as "not checked" — the one
    # thing it must never do is print `clean`.
    uncomparable="$uncomparable $key"
    if is_uncheckable "$key"; then
      echo "NOT CHECKED    $key — declared: cannot render at its own defaults"
    else
      new_uncheckable="$new_uncheckable $key"
      echo "NEWLY UNCHECKABLE  $key — the chart cannot render at its own defaults, so there is no"
      echo "                   published reference: $(head -1 "$workdir/$key.err" | cut -c1-84)"
    fi
    continue
  fi

  hits="$(ADDON_ID="$key" python3 - "$workdir/$key.ours.yaml" "$workdir/$key.theirs.yaml" <<'PY'
import base64, os, re, sys

def secret_values(path):
    """value -> set of data keys, across every Secret in the document.

    BOTH `data:` (base64) and `stringData:` (plaintext) are read. The extraction-broke comment below
    names a stringData block as a cause, and it was right: the NATS chart the `topic` node installs
    renders its only Secret as `stringData`, so this scan reported it unreadable and checked nothing
    (#3299). A plaintext credential is exactly as published as a base64 one.

    Returns (values, read_any). `read_any` counts every entry this scan could READ, BEFORE the
    length filter — it answers "can this scan still see this chart", which is a different question
    from "did anything survive as a credential candidate".
    """
    found, in_secret, read_any = {}, False, 0
    block = None          # "data" | "stringData" | None — which mapping we are inside
    pending_key = None    # the key of a block scalar being gathered
    pending_block = None  # the mapping THAT key belongs to, captured when the block scalar opened:
                          # `block` can have moved on by the time flush() runs
    pending_lines = []

    def flush():
        nonlocal pending_key, pending_block, pending_lines, read_any
        if pending_key is not None:
            val = "\n".join(pending_lines).strip()
            # A `data:` entry is base64 WHEREVER it is written. Charts render
            # `{{ .Values.tls.crt | b64enc | nindent 4 }}` under `data:` as a block scalar, and
            # decoding only the inline path would apply the 128-char filter to the base64 form —
            # ~33% longer — so a 100-byte shipped credential survives the filter inline and is
            # silently dropped as a block. Same namespace of values, two representations.
            if val and pending_block == "data":
                try:
                    val = base64.b64decode(val).decode("utf-8", "strict")
                except Exception:
                    val = ""
            if val:
                read_any += 1
                if len(val) <= 128:
                    found.setdefault(val, set()).add(pending_key)
        pending_key, pending_block, pending_lines = None, None, []

    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.rstrip("\n")
        if line.startswith("kind: Secret"):
            flush(); in_secret, block = True, None
            continue
        if line.startswith("kind: ") or line.startswith("---"):
            flush(); in_secret, block = False, None
            continue
        if not in_secret:
            continue
        # A block scalar's continuation lines are indented deeper than its key.
        if pending_key is not None:
            if line.startswith("    ") or line.strip() == "":
                pending_lines.append(line[4:] if line.startswith("    ") else "")
                continue
            flush()
        if re.match(r"^(data|stringData):\s*$", line):
            block = line.split(":", 1)[0]
            continue
        if re.match(r"^[A-Za-z]", line):   # left the Secret's top-level mapping
            block = None
            continue
        if block is None:
            continue
        # EVERY block-scalar indicator, not the four common ones. YAML also allows the KEEP
        # chomping indicator and an explicit indentation indicator — `|+`, `>+`, `|2`, `|-2`. A
        # narrower match falls through to the scalar regex below, which happily records the
        # INDICATOR as the value (`ca.crt: |+` → val "|+"), reports it as a published default
        # because theirs renders the same indicator, and drops the actual content lines — with
        # `read_any` non-zero, so the extraction-broke net does not catch it either.
        m = re.match(r'^  ([A-Za-z0-9_.\-]+): [|>][-+]?[0-9]?\s*$', line)
        if m:
            pending_key, pending_block = m.group(1), block
            pending_lines = []
            continue
        m = re.match(r'^  ([A-Za-z0-9_.\-]+): "?(.*?)"?\s*$', line)
        if not m or m.group(2) == "":
            continue
        key, val = m.group(1), m.group(2)
        if block == "data":
            if not re.fullmatch(r"[A-Za-z0-9+/=]{4,}", val):
                continue
            try:
                val = base64.b64decode(val).decode("utf-8", "strict")
            except Exception:
                continue
        read_any += 1
        # Long values are certificates, keys and embedded config files — not shipped credential
        # constants, and a value we generate would not match theirs anyway. Applied AFTER counting:
        # a value excluded here was read perfectly well.
        if 0 < len(val) <= 128:
            found.setdefault(val, set()).add(key)
    flush()
    return found, read_any

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

ours, ours_read = secret_values(sys.argv[1])
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
# Keyed on whether anything was READ, not on whether anything survived the length filter. A chart
# whose only Secret holds one long embedded config — kube-prometheus-stack, once Grafana reads its
# admin credential from a runner-seeded Secret and stops rendering its own — decodes fine and
# legitimately yields no credential candidates. Reporting that as a broken extractor is a false
# alarm on a chart that is working exactly as intended.
if candidate_data_lines(sys.argv[1]) > 0 and ours_read == 0:
    print(f"{addon}\t!EXTRACTION-YIELDED-NOTHING")
    sys.exit(0)

for value in sorted(set(ours) & set(theirs)):
    for key in sorted(ours[value]):
        print(f"{addon}\t{key}")
PY
)"

  if [ -z "$hits" ]; then
    printf '%s\n' "$key" >> "$compared_file"
    echo "clean          $key"
    continue
  fi

  if printf '%s' "$hits" | grep -q '!EXTRACTION-YIELDED-NOTHING'; then
    unreadable="$unreadable $key"
    echo "EXTRACTION BROKE  $key — the render contains Secret documents but none decoded."
    echo "                  The scan cannot see this chart any more; it has NOT been checked."
    continue
  fi

  printf '%s\n' "$key" >> "$compared_file"
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
    grep -qxF "$entry" "$seen_file" 2>/dev/null && continue
    # WHOSE entry is this? An allowlist line is `<chart-key>.<secret data key>`, and the chart key
    # may itself contain dots (`hetzner-service.registry-app-images`), so it is matched against the
    # charts that were compared rather than split on the last dot.
    owner=""
    while IFS= read -r c; do
      [ -n "$c" ] || continue
      case "$entry" in "$c".*) owner="$c" ;; esac
    done < "$workdir/all-keys.txt"
    if [ -n "$owner" ] && ! grep -qxF "$owner" "$compared_file" 2>/dev/null; then
      # NOT stale — never measured. Saying "remove it" here would delete a real declaration because
      # goharbor was unreachable for ninety seconds, and the next run would report the credential as
      # a NEW published default. The chart's own failure is already fatal below; this line exists so
      # the two are not confused.
      echo "NOT RE-CHECKED $entry — its chart did not render on this run, so this says nothing about whether it is fixed"
      continue
    fi
    stale="$stale $entry"
    echo "NO LONGER SHIPPED  $entry — remove it from $(basename "$allowfile")"
  done <<< "$declared"
fi

echo
# COUNT WHAT WAS CHECKED. `$total` is what the fixtures YIELDED, written before any render happens,
# and it includes every chart that was declared uncheckable, failed to render, was unreachable or
# whose Secrets could not be read. Printing it as the coverage number is how a run where goharbor
# was down still ends with a confident "checked 27" — the exact shape this file refuses elsewhere.
# `|| true`, NOT `|| echo 0`. `grep -c` on an empty file PRINTS `0` and EXITS 1, so `|| echo 0`
# appends a second line and the value becomes the two-line string `0\n0`. `[ "$compared_n" -ne
# "$total" ]` then dies with `integer expression expected` and takes the FALSE branch — suppressing
# the `NOT compared:` list in the one run where NOTHING was compared, which is exactly the run a
# reader needs it. Line 134 above already uses `|| true` for the same reason.
compared_n="$(grep -c '[^[:space:]]' "$compared_file" 2>/dev/null || true)"
compared_n="${compared_n:-0}"
echo "checked $compared_n of $total chart render(s) ($(cat "$workdir/n.catalog") marketplace add-on(s) + $(cat "$workdir/n.dataservice") hetzner data-service spec(s) yielded)"
if [ "$compared_n" -ne "$total" ]; then
  echo "  NOT compared:${uncomparable}${failed}${unreachable}${unreadable} — see the lines above for which and why"
fi

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
if [ -n "$unreachable" ]; then
  echo "FAIL: chart(s) could not be FETCHED:$unreachable" >&2
  echo "      This is a fetch failure against a third-party host, not a statement about the" >&2
  echo "      add-on's defaults — the chart was never rendered, so nothing was compared. See #2754." >&2
  exit 1
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
