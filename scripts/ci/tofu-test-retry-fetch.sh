#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# `tofu test`, retrying ONLY a failure that means "we could not reach a chart repository".
#
# WHY THIS EXISTS (#2489). `tofu test` is not hermetic on one cloud. hetzner declares three
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
# That is the defect exactly — "a fetch failure is indistinguishable from a render failure". #2754
# is the same class on the other job, the add-on chart render check.
#
# WHY IT IS A SCRIPT AND NOT INLINE. `tofu test` runs in TWO places against the same directory:
# the `OpenTofu Test` step in .github/workflows/infra-templates.yml, and again inside
# .github/actions/iac-checks. Guarding only the first leaves the identical flake able to red the
# identical check one step later, which is how half a fix reads as a whole one.
#
# WHAT IT REFUSES TO DO. A failure that is not network-shaped fails on the FIRST attempt, because
# retrying a real failure is how a gate quietly stops gating. This only makes the failure honest;
# genuinely hermetic renders would retire it, and #2489 carries that.
#
# THE CLASSIFIER IS NOT DEFINED HERE. It is read from scripts/ci/chart-fetch-network-errors.txt,
# which apps/console/scripts/check-addon-charts-render.mjs also reads — the other job that renders
# third-party charts on every PR and has to answer the same question. Two copies would drift, and
# silently: the copy nobody updated keeps retrying a failure the other has learned is real. That
# file's header carries the reasoning, including the two shapes deliberately kept OUT of it.

set -uo pipefail

# ── --self-test ───────────────────────────────────────────────────────────────────────────────────
#
# WHAT IT HAS TO PROVE, and why each is here rather than obvious:
#
# · A GENUINE failure is not retried. This is the whole risk of the file — a retry that quietly
#   re-rolls a real assertion failure is a gate that has stopped gating.
# · A retry actually HAPPENS. Asserting the exit code alone cannot see this: a script that gives up
#   after one attempt exits with the same code as one that tried three times. So the stub records
#   every invocation to a FILE and the count is asserted. A counter in a shell variable would not
#   survive — `$( )` is a subshell, and a previous harness in this repo passed for exactly that
#   reason.
# · It runs under `bash -e`. A `run:` step with no `shell:` gets GitHub's default `bash -e {0}`, and
#   the body of a `while` is not an -e-exempt context. An earlier version of this logic was 100%
#   INERT in CI for that reason while passing a harness that ran it under plain `bash`. Every case
#   below therefore invokes the script as `bash -e`, which is the condition that matters.
# · Network-shaped but NOT a chart fetch fails closed. The context requirement is the thing that
#   keeps an unrelated transport error — a provider download, a backend call — from being waved
#   through as a known flake.
# · An unreadable or empty classifier REFUSES. An empty `fetch_err` makes `grep -qE ""` match every
#   line, so the failure mode of losing the patterns file is "retry everything", which is the worst
#   available answer and the one that looks like it is working.
if [ "${1:-}" = "--self-test" ]; then
  set -uo pipefail
  set +e   # the assertions below READ exit codes; -e would abort on the first one
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  pass=0 fail=0

  # A stub `tofu` that records EVERY invocation and replays a scenario. The record is a file, not a
  # variable, because the assertions below read it from a different shell than the one that wrote it.
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/tofu" <<'STUB'
#!/usr/bin/env bash
echo "call" >> "$STUB_CALLS"
n=$(grep -c . "$STUB_CALLS")
case "$STUB_SCENARIO" in
  pass) echo "Success! 11 passed, 0 failed."; exit 0 ;;
  render)
    echo 'checks_dns_and_network.tftest.hcl... fail'
    echo '  Error: Invalid value for variable'
    echo '    on checks_dns_and_network.tftest.hcl line 181, in run "an_existing_network_with_no_id_blocks_the_plan":'
    echo 'Failure! 10 passed, 1 failed.'
    exit 1 ;;
  fetch)
    echo 'Error: looks like "https://charts.hetzner.cloud" is not a valid chart repository or cannot be reached: Get "https://charts.hetzner.cloud/index.yaml": read tcp: connection reset by peer'
    echo '  with data.helm_template.hcloud_ccm, on cilium.tf line 111'
    exit 1 ;;
  netonly)
    echo 'Error: Failed to install provider: dial tcp: i/o timeout'
    exit 1 ;;
  fetch_then_pass)
    if [ "$n" -lt 2 ]; then
      echo 'Error: looks like "https://helm.cilium.io" is not a valid chart repository or cannot be reached: TLS handshake timeout'
      echo '  with data.helm_template.cilium, on cilium.tf line 40'
      exit 1
    fi
    echo "Success! 11 passed, 0 failed."; exit 0 ;;
esac
STUB
  chmod +x "$tmp/bin/tofu"

  ok() { # label expected_rc expected_calls scenario [extra-env...]
    local label="$1" want_rc="$2" want_calls="$3" scenario="$4"; shift 4
    : > "$tmp/calls"
    local out rc
    out="$(cd "$tmp" && env PATH="$tmp/bin:$PATH" STUB_CALLS="$tmp/calls" STUB_SCENARIO="$scenario" \
      TOFU_TEST_FETCH_ATTEMPTS=3 TOFU_TEST_FETCH_SLEEP_BASE=0 "$@" bash -e "$self" hetzner 2>&1)"
    rc=$?
    local calls; calls=$(wc -l < "$tmp/calls" | tr -d " ")
    if [ "$rc" = "$want_rc" ] && [ "$calls" = "$want_calls" ]; then
      echo "ok   - $label"; pass=$((pass + 1))
    else
      echo "FAIL - $label: rc=$rc (want $want_rc), attempts=$calls (want $want_calls)"
      printf '%s\n' "$out" | sed 's/^/         /' | head -6
      fail=$((fail + 1))
    fi
    printf '%s' "$out" > "$tmp/last-out"
  }
  says() {
    if grep -qF "$2" "$tmp/last-out"; then echo "ok   - $1"; pass=$((pass + 1));
    else echo "FAIL - $1: output did not contain $2"; fail=$((fail + 1)); fi
  }

  # The negative first: regressing it is the entire cost of being wrong here.
  ok "a genuine test failure is NOT retried" 1 1 render
  says "...and it says so, rather than blaming a host" "this is a TEST failure, not a chart-fetch failure"

  ok "a passing run runs once" 0 1 pass

  ok "a chart-fetch failure is retried to the ceiling" 1 3 fetch
  says "...and the final message calls it a FETCH failure" "This is a FETCH failure"
  says "...and names the host it could not reach" "https://charts.hetzner.cloud"

  ok "a fetch flake that clears is a PASS, not a red" 0 2 fetch_then_pass

  # Network-shaped, but the error is a provider download rather than a chart fetch.
  ok "a network error outside a chart fetch fails closed on attempt 1" 1 1 netonly

  # Losing the classifier must make it REFUSE, never retry everything.
  cp "$self" "$tmp/copy.sh"
  : > "$tmp/calls"
  out="$(cd "$tmp" && env PATH="$tmp/bin:$PATH" STUB_CALLS="$tmp/calls" STUB_SCENARIO=render \
    TOFU_TEST_FETCH_SLEEP_BASE=0 bash -e "$tmp/copy.sh" hetzner 2>&1)"; rc=$?
  if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "cannot read"; then
    echo "ok   - a missing classifier file refuses instead of retrying everything"; pass=$((pass + 1))
  else
    echo "FAIL - a missing classifier file refuses instead of retrying everything: rc=$rc"; fail=$((fail + 1))
  fi

  mkdir -p "$tmp/empty"
  cp "$self" "$tmp/empty/copy.sh"
  printf '# only a comment\n\n' > "$tmp/empty/chart-fetch-network-errors.txt"
  out="$(cd "$tmp" && env PATH="$tmp/bin:$PATH" STUB_CALLS="$tmp/calls" STUB_SCENARIO=render \
    TOFU_TEST_FETCH_SLEEP_BASE=0 bash -e "$tmp/empty/copy.sh" hetzner 2>&1)"; rc=$?
  if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q "yielded no patterns"; then
    echo "ok   - an empty classifier refuses: a blank regex matches every line"; pass=$((pass + 1))
  else
    echo "FAIL - an empty classifier refuses: rc=$rc"; fail=$((fail + 1))
  fi

  echo
  if [ "$fail" -eq 0 ]; then echo "tofu-test-retry-fetch self-test: all $pass passed"; exit 0; fi
  echo "tofu-test-retry-fetch self-test: $fail of $((pass + fail)) FAILED"; exit 1
fi

cloud="${1:-$(basename "$PWD")}"
attempts="${TOFU_TEST_FETCH_ATTEMPTS:-3}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Network-shaped, from the shared list. An EMPTY result is fatal rather than permissive: a blank
# `fetch_err` makes `grep -qE ""` match every line, so every failure would look like a flake and be
# retried — a classifier that cannot read its own rules must refuse, not wave everything through.
patterns_file="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/chart-fetch-network-errors.txt"
if [ ! -r "$patterns_file" ]; then
  echo "::error title=classifier missing::cannot read ${patterns_file} — refusing to classify failures without it." >&2
  exit 2
fi
# `|| true` is LOAD-BEARING and not defensive noise. `grep -v` exits 1 when it selects nothing, this
# script runs under `bash -e` in CI, and `set -o pipefail` is on — so a patterns file holding only
# comments would abort the assignment and never reach the emptiness check three lines down. The
# check below is the one that must report it, because "the classifier is empty" and "the script
# crashed" are different diagnoses and only one of them names the cause. Found by --self-test.
fetch_err="$( { grep -vE '^[[:space:]]*(#|$)' "$patterns_file" || true; } | paste -sd'|' - )"
if [ -z "$fetch_err" ]; then
  echo "::error title=classifier empty::${patterns_file} yielded no patterns — an empty regex matches everything and would retry a real failure." >&2
  exit 2
fi

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
    echo "::error title=chart fetch failed (#2489)::${cloud}: could not REACH ${host} in ${attempts} attempts. This is a FETCH failure — the template was never evaluated, so it says nothing about the template. See #2489."
    exit "$rc"
  fi

  # The backoff base is a variable ONLY so --self-test can drive it to zero. Nothing in CI sets
  # it: a test that has to wait 30s to prove a retry is a test nobody runs.
  backoff=$((attempt * ${TOFU_TEST_FETCH_SLEEP_BASE:-10}))
  echo "::warning title=chart fetch flake (#2489)::${cloud}: attempt ${attempt}/${attempts} could not reach ${host} — a live third-party fetch, not a template failure. Retrying in ${backoff}s."
  sleep "$backoff"
  attempt=$((attempt + 1))
done
