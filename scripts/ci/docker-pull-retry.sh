#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Pull container images into the runner's docker, retrying ONLY a rate limit or a failure that means
# "the registry did not answer" (#6044). A sibling of go-mod-download-retry.sh (#6031), built the
# same way.
#
# USAGE
#   docker-pull-retry.sh <image>...      `docker pull` each image, in order; stops at the first that
#                                        fails for good
#   docker-pull-retry.sh --self-test
#
# WHY IT EXISTS. T1 (ci.yml → provision-e2e) installs the argo-cd chart into a kind cluster. Its
# redis is `ecr-public.aws.com/docker/library/redis:…`, and ECR Public rate-limits anonymous pulls
# per source IP. GitHub's runners share IPs, so when the kubelet inside kind pulled it, overlapping
# runs got `toomanyrequests`, redis sat in ImagePullBackOff and the queue batch went red. The job now
# pulls every image the chart renders HERE, on the runner, where a rate limit can be waited out, and
# the T1 test loads them into kind (test/e2e/t1_image_preload.go).
#
# WHAT IT REFUSES TO DO. A failure is retried only when the output carries a rate-limit or transport
# error from the list below. Anything else fails on the FIRST attempt with docker's own exit code: a
# tag that does not exist (`manifest unknown`), a private image (`unauthorized`, `denied`), a daemon
# that is not running. Retrying those is how a step stops reporting the real failure, and the
# --self-test below fails if that is ever introduced.
#
# WHAT IT DOES NOT HIDE. Every retry prints a `::warning`, and a retry that eventually succeeds
# prints one more saying so, so a registry that keeps limiting us stays visible on the run's summary
# instead of being absorbed by a green step. The last failure is an `::error` that calls it a PULL
# failure.

set -uo pipefail

# Rate-limit and transport shapes only, one POSIX ERE alternative each, matched case-insensitively.
# The bar for adding one: the REGISTRY or the NETWORK produces it, never a reference that is wrong.
# That is why `manifest unknown`, `not found`, `unauthorized` and `denied` are not here, and why the
# 5xx entries carry their status text.
NET_ERR='toomanyrequests|429 Too Many Requests|connection reset|TLS handshake timeout|i/o timeout|unexpected EOF|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out'

# ── --self-test ───────────────────────────────────────────────────────────────────────────────────
#
# A stub `docker` on PATH replays a scenario and appends every invocation to a FILE. The count is
# asserted, not only the exit code: a script that gives up after one attempt exits with the same
# code as one that tried three times.
#
# Every case invokes the script as `bash -e`, which is what a `run:` step with no `shell:` uses. A
# retry loop whose failing command aborts the script under -e makes one attempt and never classifies
# anything, while passing a harness that runs it under plain `bash`.
#
# The run's exit code IS the test: any failed case makes it exit 1.
if [ "${1:-}" = "--self-test" ]; then
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  pass=0 fail=0

  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_CALLS"
n=$(grep -c . "$STUB_CALLS")
case "$STUB_SCENARIO" in
  pass)
    echo "$2: Pulling from library/redis"
    exit 0 ;;
  real)
    echo "$STUB_LINE" >&2
    exit 1 ;;
  flaky_always)
    echo "$STUB_LINE" >&2
    exit 1 ;;
  flaky_once)
    if [ "$n" -lt 2 ]; then echo "$STUB_LINE" >&2; exit 1; fi
    echo "$2: Pulling from library/redis"
    exit 0 ;;
esac
STUB
  chmod +x "$tmp/bin/docker"

  # run LABEL WANT_RC WANT_CALLS SCENARIO LINE ARGS...
  run() {
    local label="$1" want_rc="$2" want_calls="$3" scenario="$4" line="$5"; shift 5
    : > "$tmp/calls"
    local rc=0
    (cd "$tmp" && env PATH="$tmp/bin:$PATH" STUB_CALLS="$tmp/calls" STUB_SCENARIO="$scenario" \
      STUB_LINE="$line" DOCKER_PULL_RETRY_ATTEMPTS=3 DOCKER_PULL_RETRY_SLEEP_BASE=0 \
      bash -e "$self" "$@" >"$tmp/out" 2>"$tmp/err") || rc=$?
    local calls; calls=$(grep -c . "$tmp/calls" || true)
    if [ "$rc" = "$want_rc" ] && [ "$calls" = "$want_calls" ]; then
      echo "ok   - $label"; pass=$((pass + 1))
    else
      echo "FAIL - $label: rc=$rc (want $want_rc), attempts=$calls (want $want_calls)"
      sed 's/^/         /' "$tmp/err" | head -8
      fail=$((fail + 1))
    fi
  }
  says() { # LABEL FILE NEEDLE
    if grep -qF -- "$3" "$tmp/$2"; then echo "ok   - $1"; pass=$((pass + 1));
    else echo "FAIL - $1: $2 did not contain: $3"; fail=$((fail + 1)); fi
  }

  # The negatives first: retrying any of these is the entire cost of being wrong here.
  run "a tag that does not exist is NOT retried" 1 1 real \
    'Error response from daemon: manifest for quay.io/argoproj/argocd:v9.9.9 not found: manifest unknown: manifest unknown' quay.io/argoproj/argocd:v9.9.9
  says "...and it says it is not retrying" err "not a rate limit or a transport error — not retrying"
  run "a private image (unauthorized) is NOT retried" 1 1 real \
    'Error response from daemon: Head "https://ghcr.io/v2/acme/private/manifests/v1": unauthorized' ghcr.io/acme/private:v1
  run "a daemon that is not running is NOT retried" 1 1 real \
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' redis:8
  run "a bare 503 (not a status line) is NOT retried" 1 1 real \
    'Error response from daemon: invalid reference format: repository name (503/x) must be lowercase' 503/X

  run "a passing pull runs once" 0 1 pass "" ecr-public.aws.com/docker/library/redis:8.2.3-alpine
  says "...and pulls the image it was given" out "ecr-public.aws.com/docker/library/redis:8.2.3-alpine: Pulling from"

  limited='Error response from daemon: toomanyrequests: Rate exceeded'
  run "a rate limit that persists is retried to the ceiling, then fails" 1 3 flaky_always "$limited" redis:8
  says "...and the last attempt calls it a PULL failure" err "This is a PULL failure"
  says "...and every retry is logged" err "attempt 2/3 failed on a rate limit or transport error"

  run "a rate limit that clears is a pass" 0 2 flaky_once "$limited" redis:8
  says "...and the success says it retried, so a limiting registry stays visible" err "succeeded on attempt 2/3 after 1 transient failure"

  for line in \
    'failed to copy: httpReadSeeker: failed open: unexpected status code https://ecr-public.aws.com/v2/docker/library/redis/blobs/sha256:ab: 429 Too Many Requests - Server message: toomanyrequests: Rate exceeded' \
    'Error response from daemon: Get "https://quay.io/v2/": net/http: TLS handshake timeout' \
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: i/o timeout' \
    'Error response from daemon: read tcp 10.1.0.4:5000->1.2.3.4:443: read: connection reset by peer' \
    'error pulling image configuration: download failed after attempts=6: unexpected EOF' \
    'Error response from daemon: received unexpected HTTP status: 502 Bad Gateway' \
    'Error response from daemon: received unexpected HTTP status: 503 Service Unavailable' \
    'Error response from daemon: received unexpected HTTP status: 504 Gateway Timeout'; do
    run "retried: ${line##*: }" 0 2 flaky_once "$line" redis:8
  done

  run "several images are each pulled, in order" 0 2 pass "" a:1 b:2
  if [ "$(cat "$tmp/calls")" = "$(printf 'pull a:1\npull b:2')" ]; then
    echo "ok   - ...as plain \`docker pull <image>\`"; pass=$((pass + 1))
  else echo "FAIL - invoked: $(tr '\n' ';' < "$tmp/calls")"; fail=$((fail + 1)); fi
  run "the first image that fails for good stops the run" 1 1 real 'manifest unknown' a:1 b:2

  run "no arguments is a usage error, not a silent pass" 2 0 pass ""

  echo
  if [ "$fail" -eq 0 ]; then echo "docker-pull-retry self-test: all $pass passed"; exit 0; fi
  echo "docker-pull-retry self-test: $fail of $((pass + fail)) FAILED"; exit 1
fi

attempts="${DOCKER_PULL_RETRY_ATTEMPTS:-5}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Print the first output line that is a rate limit or a transport error; print nothing and return 1
# for anything else. A here-string rather than a pipe into `grep -q`, because under `pipefail` an
# early-exiting `grep -q` can SIGPIPE the writer and turn a match into a failure.
transient_line() {
  local hits
  hits="$(grep -Ei -- "$NET_ERR" "$1" || true)"
  [ -n "$hits" ] || return 1
  head -n 1 <<<"$hits"
}

# Pull image $1 until it succeeds, a non-transient failure occurs, or the attempts run out.
pull_one() {
  local image="$1" attempt=1 rc line backoff
  while :; do
    # `if` keeps a failing pull from ending the script under `bash -e`.
    if docker pull "$image" >"$work/out" 2>&1; then rc=0; else rc=$?; fi
    cat "$work/out"
    if [ "$rc" -eq 0 ]; then
      if [ "$attempt" -gt 1 ]; then
        echo "::warning title=Image pull retried (#6044)::${image}: succeeded on attempt ${attempt}/${attempts} after $((attempt - 1)) transient failure(s). Nothing failed, but the registry is limiting or flaking — see the warnings above." >&2
      fi
      return 0
    fi
    if ! line="$(transient_line "$work/out")"; then
      echo "::error title=Image pull failed::${image}: docker pull exited ${rc}, and that is not a rate limit or a transport error — not retrying." >&2
      return "$rc"
    fi
    line="${line//%/%25}"
    if [ "$attempt" -ge "$attempts" ]; then
      echo "::error title=Image pull failed (#6044)::${image}: could not pull in ${attempts} attempts. This is a PULL failure, not a test failure. Last error: ${line}" >&2
      return "$rc"
    fi
    # The base is a variable only so --self-test can drive it to zero; CI leaves it at 15s, so five
    # attempts wait 15+30+45+60s — long enough for a per-second anonymous limit to clear.
    backoff=$((attempt * ${DOCKER_PULL_RETRY_SLEEP_BASE:-15}))
    echo "::warning title=Image pull retried (#6044)::${image}: attempt ${attempt}/${attempts} failed on a rate limit or transport error — retrying in ${backoff}s. ${line}" >&2
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
}

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <image>... | --self-test" >&2
  exit 2
fi

for image in "$@"; do
  pull_one "$image" || exit $?
done
