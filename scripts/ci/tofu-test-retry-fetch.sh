#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `tofu test`, retrying ONLY a failure that means "we could not reach a chart repository".
#
# WHY THIS EXISTS (#2754). `tofu test` is not hermetic on one cloud. hetzner declares three
# `data "helm_template"` sources against two third-party hosts — charts.hetzner.cloud and
# helm.cilium.io — and a data source is evaluated at PLAN, so every run fetches an index.yaml
# and a chart tarball live from someone else's server. No other cloud template declares a
# `helm_template` at all. On 2026-08-28 a TCP reset from charts.hetzner.cloud failed
# `check (hetzner)` on the staging→main promotion PR #3117 and read as a template defect:
#
#   Error: looks like "https://charts.hetzner.cloud" is not a valid chart repository or cannot
#   be reached: … read: connection reset by peer
#     with data.helm_template.hcloud_ccm, on cilium.tf line 111
#
# That is #2754 exactly — "a fetch failure is indistinguishable from a render failure".
#
# WHY IT IS A SCRIPT AND NOT INLINE. `tofu test` runs in TWO places against the same directory:
# the `OpenTofu Test` step in .github/workflows/infra-templates.yml, and again inside
# .github/actions/iac-checks. Guarding only the first leaves the identical flake able to red the
# identical check one step later, which is how half a fix reads as a whole one.
#
# WHAT IT REFUSES TO DO. A failure that is not network-shaped fails on the FIRST attempt, because
# retrying a real failure is how a gate quietly stops gating. The durable fix is to stop fetching
# third-party charts in CI at all (#2754); this only makes the failure honest meanwhile.

set -uo pipefail

cloud="${1:-$(basename "$PWD")}"
attempts="${TOFU_TEST_FETCH_ATTEMPTS:-3}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Network-shaped, and deliberately NOT a catch-all.
#
# `unexpected EOF` and a bare trailing `EOF` were in an earlier draft and are REMOVED: "unexpected
# EOF" is the classic OpenTofu plugin-CRASH message — infra-templates.yml documents 1.9.0 crashing
# on hetzner's own suite (opentofu/opentofu#2993) — and a bare `EOF` matches any error whose echoed
# source snippet ends a heredoc (aws/modules/dynamodb/variables.tf:89 is literally `  EOF`). Either
# would retry a genuine crash three times and then report it as a host we could not reach, which is
# the same misdirection this script exists to remove, pointed the other way.
fetch_err='not a valid chart repository or cannot be reached|connection reset by peer|TLS handshake timeout|no such host|i/o timeout|Client\.Timeout exceeded|temporary failure in name resolution|502 Bad Gateway|503 Service Unavailable'

# A network-shaped string is necessary but NOT sufficient: it must also be a CHART fetch. Requiring
# the helm context keeps an unrelated transport error (a provider download, a backend call) from
# being waved through as a known flake. Anything this does not match fails closed, on attempt 1.
helm_ctx='helm_template|chart repository'

attempt=1
while :; do
  # `set +e` around the pipeline is LOAD-BEARING. A `run:` step with no `shell:` gets GitHub's
  # default `bash -e {0}`, and the body of a `while` is not an -e-exempt context — so a failing
  # pipeline terminates the step on the spot and `rc=${PIPESTATUS[0]}` is never reached. An earlier
  # version of this logic was inert for exactly that reason: under `bash -e` it made ONE attempt and
  # never classified, warned or retried, while passing a harness that ran it under plain `bash`.
  set +e
  tofu test 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}   # NOT $? — a pipeline reports the LAST command's status, and tee always succeeds.
  set -e

  [ "$rc" -eq 0 ] && break

  if ! grep -qEi "$fetch_err" "$log" || ! grep -qEi "$helm_ctx" "$log"; then
    echo "::error title=tofu test failed::${cloud}: this is a TEST failure, not a chart-fetch failure — not retrying."
    exit "$rc"
  fi

  host="$(grep -oE 'https://[a-zA-Z0-9._-]+' "$log" | head -1)"
  host="${host:-a chart repository}"

  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error title=chart fetch failed (#2754)::${cloud}: could not REACH ${host} in ${attempts} attempts. This is a FETCH failure — the template was never evaluated, so it says nothing about the template. See #2754."
    exit "$rc"
  fi

  echo "::warning title=chart fetch flake (#2754)::${cloud}: attempt ${attempt}/${attempts} could not reach ${host} — a live third-party fetch, not a template failure. Retrying in $((attempt * 10))s."
  sleep $((attempt * 10))
  attempt=$((attempt + 1))
done
