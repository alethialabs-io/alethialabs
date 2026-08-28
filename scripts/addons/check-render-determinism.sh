#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Renders every catalogued add-on TWICE and fails if the two renders differ.
#
# WHY THIS EXISTS
#
# A Helm chart that generates a credential at RENDER time — `randAlphaNum`, `genCA`,
# `genSignedCert`, a bcrypt salt — produces different output every time it is rendered. Under
# ArgoCD, which re-renders on every reconcile, that is not cosmetic:
#
#   * the Secret never matches the live one, so the Application is PERMANENTLY OutOfSync;
#   * with selfHeal on, ArgoCD rewrites it every reconcile;
#   * charts that stamp a `checksum/secret` annotation onto their pod templates therefore roll
#     their pods on every reconcile, forever;
#   * and the rotating value is often load-bearing — harbor's `core.tokenKey` signs the registry
#     auth tokens, so rotating it invalidates every `docker pull` token the registry ever issued.
#
# Two add-ons were shipping this (#2822 minio, #2823 harbor) and neither was found by reading the
# catalog — the charts look fine and their values are all defaults. Both were found by rendering
# twice and diffing, which costs a minute and no cloud spend. That is the whole method, so it is
# encoded here rather than left as something someone might think to do again.
#
# THE ALLOWLIST IS A RATCHET
#
# `scripts/addons/render-nondeterministic.txt` lists the add-ons known to be non-deterministic,
# each with the issue tracking its fix. The check fails if
#   * an add-on NOT on the list renders non-deterministically (a new regression), OR
#   * an add-on ON the list now renders deterministically (fixed — remove it, so the list can
#     only ever shrink), OR
#   * a chart fails to render at all, OR
#   * the fixture yields no add-ons.
#
# That last pair matters: a sweep whose "found nothing" branch is indistinguishable from its
# "nothing is wrong" branch is the defect class this repo has paid for repeatedly.

set -euo pipefail

# A chart we could not REACH is not a chart that renders wrongly (#2754) — see the lib header.
. "$(dirname "${BASH_SOURCE[0]}")/lib/chart-fetch.sh"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Any ONE per-cloud fixture is enough: this check renders each CHART at its pinned coordinates to
# prove the render is deterministic, and the chart/repo/version fields are identical across clouds
# (only external-dns's `provider` knob differs). hetzner is chosen because it is the harness's own
# default cloud, so this file and addonCatalogFixture() agree on which fixture "the" fixture is.
fixture="$repo_root/test/e2e/fixtures/addon_catalog.hetzner.json"
allowfile="$repo_root/scripts/addons/render-nondeterministic.txt"

command -v helm >/dev/null 2>&1 || { echo "check-render-determinism: helm is not installed" >&2; exit 2; }
[ -r "$fixture" ] || { echo "check-render-determinism: no fixture at $fixture" >&2; exit 2; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# The fixture is the resolved install specs the runner would actually install — the same input the
# e2e harness seeds — so this checks what ships, not a hand-kept second list of charts.
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

# Count NON-EMPTY lines: an empty spec list still writes a trailing newline, so `wc -l` reports 1
# and the "nothing was checked" branch below becomes unreachable — the sweep then degrades into a
# confusing "chart did not render" instead of saying it checked nothing. Caught by mutation.
total="$(grep -c '[^[:space:]]' "$workdir/charts.txt" || true)"
if [ "$total" -eq 0 ]; then
  echo "check-render-determinism: the fixture yielded ZERO add-ons — nothing was checked" >&2
  exit 2
fi

# Declared exceptions, comments and blanks stripped.
declared=""
if [ -r "$allowfile" ]; then
  declared="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$allowfile" | grep -v '^$' || true)"
fi

is_declared() { printf '%s\n' "$declared" | grep -qx "$1"; }

while read -r id repo chart version ns; do
  helm repo add "rd-$id" "$repo" >/dev/null 2>&1 || true
done < "$workdir/charts.txt"
chart_fetch_repo_update "$workdir/repo-update.err" || true

nondet=""
fixed=""
failed=""
unreachable=""

while read -r id repo chart version ns; do
  [ -n "$id" ] || continue
  # Both renders are retried together on a network-shaped miss: this check compares them to
  # each other, so one fetched half and one empty half is not a comparison. Only the FETCH is
  # retried — a chart that downloads and then renders wrongly fails on the first attempt.
  render_pair() {
    local i
    for i in 1 2; do
      helm template "addon-$id" "rd-$id/$chart" \
        --version "$version" --namespace "$ns" \
        --values "$workdir/$id.values.json" \
        --kube-version 1.30.0 \
        > "$workdir/$id.$i.yaml" 2> "$workdir/$id.$i.err" || true
    done
    [ -s "$workdir/$id.1.yaml" ]
  }
  attempt=1
  while :; do
    render_pair && break
    if [ "$attempt" -ge "$CHART_FETCH_ATTEMPTS" ] || ! chart_fetch_is_net_err "$workdir/$id.1.err"; then
      break
    fi
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done

  if [ ! -s "$workdir/$id.1.yaml" ]; then
    # #2754: say WHICH it was. An unreachable host says nothing about the chart.
    if chart_fetch_is_net_err "$workdir/$id.1.err"; then
      unreachable="$unreachable $id"
      echo "COULD NOT FETCH $id — $(chart_fetch_host "$workdir/$id.1.err") unreachable after ${CHART_FETCH_ATTEMPTS} attempts: $(head -1 "$workdir/$id.1.err" | cut -c1-100)"
    else
      failed="$failed $id"
      echo "RENDER FAILED  $id — $(head -1 "$workdir/$id.1.err" | cut -c1-120)"
    fi
    continue
  fi

  if diff -q "$workdir/$id.1.yaml" "$workdir/$id.2.yaml" >/dev/null 2>&1; then
    if is_declared "$id"; then
      fixed="$fixed $id"
      echo "NOW STABLE     $id — renders deterministically; remove it from $(basename "$allowfile")"
    else
      echo "stable         $id"
    fi
  else
    changed="$(diff "$workdir/$id.1.yaml" "$workdir/$id.2.yaml" | grep -c '^[<>]' || true)"
    if is_declared "$id"; then
      echo "known non-det  $id — $changed differing line(s), declared"
    else
      nondet="$nondet $id"
      echo "NON-DETERMINISTIC $id — $changed differing line(s) between two identical renders"
      # Name the objects, not just the count — "which object" is the first thing anyone asks.
      # `diff` exits 1 WHEN IT FINDS A DIFFERENCE, which is the only case that reaches here — so
      # under `set -o pipefail` this pipeline aborted the whole sweep before the summary ever ran,
      # and the script exited 1 by accident rather than by verdict. Caught by mutation; the
      # explicit `|| true` is what keeps the loop alive to reach its own conclusion.
      awk '/^# Source: /{src=$3} {print NR"\t"src}' "$workdir/$id.1.yaml" > "$workdir/$id.map"
      { diff "$workdir/$id.1.yaml" "$workdir/$id.2.yaml" || true; } \
        | grep -oE '^[0-9]+' | sort -un \
        | while read -r ln; do awk -v l="$ln" -F'\t' '$1==l{print $2}' "$workdir/$id.map"; done \
        | sort -u | sed 's/^/                    /' || true
    fi
  fi
done < "$workdir/charts.txt"

echo
echo "checked $total add-on(s)"

status=0
if [ -n "$unreachable" ]; then
  echo "FAIL: chart(s) could not be FETCHED:$unreachable" >&2
  echo "      This is a fetch failure against a third-party host, not a statement about the" >&2
  echo "      catalogue — the chart was never rendered, so nothing was measured. See #2754." >&2
  exit 1
fi

if [ -n "$failed" ]; then
  echo "FAIL: chart(s) did not render at all:$failed" >&2
  status=1
fi
if [ -n "$nondet" ]; then
  echo "FAIL: undeclared non-deterministic render(s):$nondet" >&2
  echo "      Each will sit PERMANENTLY OutOfSync under ArgoCD. Pin the generated values through" >&2
  echo "      the encrypted secret store, or add the id to $(basename "$allowfile") with its issue." >&2
  status=1
fi
if [ -n "$fixed" ]; then
  echo "FAIL: declared non-deterministic but now stable:$fixed" >&2
  echo "      The list is a ratchet — drop these entries so it cannot silently grow back." >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "OK — every add-on renders identically twice, and the allowlist is exact"
exit "$status"
