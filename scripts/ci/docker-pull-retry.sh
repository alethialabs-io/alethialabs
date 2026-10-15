#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Pull container images into the runner's docker, retrying ONLY a rate limit or a failure that means
# "the registry did not answer" (#6044), and serving Docker Official Images from Google's Docker Hub
# mirror instead of anonymous ECR Public (#6067). A sibling of go-mod-download-retry.sh (#6031),
# built the same way.
#
# USAGE
#   docker-pull-retry.sh <image>...      put each image in the runner's docker under the exact
#                                        reference given, in order; stops at the first that fails
#                                        for good
#   docker-pull-retry.sh --self-test
#
# WHY IT EXISTS. T1 (ci.yml → provision-e2e) installs the argo-cd chart into a kind cluster. Its
# redis is `ecr-public.aws.com/docker/library/redis:…`, and ECR Public limits anonymous pulls per
# source IP, both in rate and in DATA. GitHub's runners share IPs: pulled by the kubelet inside kind,
# redis got `toomanyrequests`, sat in ImagePullBackOff and the queue batch went red. The job now
# pulls every image the chart renders HERE, on the runner, and the T1 test loads them into kind
# (test/e2e/t1_image_preload.go).
#
# THE MIRROR (#6067). Retrying waits out a burst limit, but not `toomanyrequests: Data limit
# exceeded`, which is a per-IP data quota that stays exhausted for the whole run. So a reference
# under ecr-public.aws.com/docker/library/ — ECR Public's copy of the Docker Official Images — is
# pulled from mirror.gcr.io/library/ (Google's Docker Hub mirror, which has no anonymous quota)
# and then `docker tag`ged to the EXACT reference given, which is the one the chart renders: `kind
# load` and the kubelet look for that name, and the product's chart values stay untouched.
#   - Only a single-segment name under that prefix is mapped (`…/docker/library/redis:8`). Every
#     other reference, including any other ECR Public repository, is pulled as given.
#   - When the reference pins a digest (`…:tag@sha256:…`), the mirror's tag is pulled and its
#     RepoDigests must carry that digest before it is tagged; a mismatch falls back to ECR Public.
#     A digest with no tag is not mapped, because `docker tag` has no tag to write. When no digest
#     is pinned the mirror's tag is trusted, and the notice says so.
#   - When the mirror fails — after its own retries — the given reference is pulled from ECR Public.
#   - A `::notice` names the source that served every mapped image.
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
# failure — a `::warning` when it was the mirror's, because ECR Public is still to be tried.

set -uo pipefail

# Rate-limit and transport shapes only, one POSIX ERE alternative each, matched case-insensitively.
# The bar for adding one: the REGISTRY or the NETWORK produces it, never a reference that is wrong.
# That is why `manifest unknown`, `not found`, `unauthorized` and `denied` are not here, and why the
# 5xx entries carry their status text.
NET_ERR='toomanyrequests|429 Too Many Requests|connection reset|connection refused|no such host|TLS handshake timeout|i/o timeout|Client\.Timeout exceeded|net/http: request canceled|unexpected EOF|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out'

# The one prefix that is mapped, and where it is mapped to.
ECR_LIBRARY='ecr-public.aws.com/docker/library/'
MIRROR_LIBRARY='mirror.gcr.io/library/'

# ── --self-test ───────────────────────────────────────────────────────────────────────────────────
#
# A stub `docker` on PATH replays a scenario and appends every invocation to a FILE. The count is
# asserted, not only the exit code: a script that gives up after one attempt exits with the same
# code as one that tried three times. The mirror cases assert the exact sequence of invocations.
#
# Every case invokes the script as `bash -e`, so a retry loop that is not errexit-safe fails here: a
# bare `docker pull` (one not guarded by `if`) would end the script at the first failed attempt, and
# every retry case below asserts more than one attempt. That only works because pull_one and
# fetch_one are called as plain commands, never inside `||`/`&&`/`if` — bash switches errexit off
# for the whole body of a function called from such a list, which would make the guard here unable
# to fail. They report their result in PULL_RC / FETCH_RC for that reason.
#
# The last block runs this self-test against MUTATED copies of the script — the prefix matched
# anywhere, a nested name mapped, the digest check skipped, the retag dropped, a mirror failure made
# final — and fails unless each mutant's self-test fails.
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
# replay BEHAVIOUR: pass | real | flaky_always | flaky_once
replay() {
  case "$1" in
    pass) echo "$3: Pulling from library/redis"; exit 0 ;;
    real|flaky_always) echo "$STUB_LINE" >&2; exit 1 ;;
    flaky_once)
      if [ "$n" -lt 2 ]; then echo "$STUB_LINE" >&2; exit 1; fi
      echo "$3: Pulling from library/redis"; exit 0 ;;
  esac
}
case "$STUB_SCENARIO" in
  route)
    # Answers by registry and subcommand, for the mirror cases.
    case "$1 $2" in
      "pull mirror.gcr.io/"*) replay "${STUB_MIRROR:-pass}" "$@" ;;
      "pull "*) replay "${STUB_ORIGIN:-pass}" "$@" ;;
      "image inspect") printf '%s\n' "${STUB_REPODIGESTS:-}"; exit 0 ;;
      "tag "*) [ "${STUB_TAG:-pass}" = pass ] && exit 0
               echo "Error response from daemon: No such image: $2" >&2; exit 1 ;;
    esac
    echo "stub: unexpected docker $*" >&2; exit 99 ;;
  *) replay "$STUB_SCENARIO" "$@" ;;
esac
STUB
  chmod +x "$tmp/bin/docker"

  # invoke WANT_RC ARGS... — runs the script under `bash -e` against the stub; sets rc and calls.
  invoke() {
    : > "$tmp/calls"
    rc=0
    (cd "$tmp" && env PATH="$tmp/bin:$PATH" STUB_CALLS="$tmp/calls" \
      DOCKER_PULL_RETRY_ATTEMPTS=3 DOCKER_PULL_RETRY_SLEEP_BASE=0 \
      bash -e "$self" "$@" >"$tmp/out" 2>"$tmp/err") || rc=$?
    calls=$(grep -c . "$tmp/calls" || true)
  }
  # run LABEL WANT_RC WANT_CALLS SCENARIO LINE ARGS...
  run() {
    local label="$1" want_rc="$2" want_calls="$3"
    export STUB_SCENARIO="$4" STUB_LINE="$5"; shift 5
    invoke "$@"
    if [ "$rc" = "$want_rc" ] && [ "$calls" = "$want_calls" ]; then
      echo "ok   - $label"; pass=$((pass + 1))
    else
      echo "FAIL - $label: rc=$rc (want $want_rc), attempts=$calls (want $want_calls)"
      sed 's/^/         /' "$tmp/err" | head -8
      fail=$((fail + 1))
    fi
  }
  # route LABEL WANT_RC WANT_SEQUENCE ARGS... — a mirror case: the exact `docker` invocations,
  # joined with `;`, are asserted. STUB_MIRROR/STUB_ORIGIN/STUB_TAG/STUB_REPODIGESTS/STUB_LINE are
  # set by the caller for this one case.
  route() {
    local label="$1" want_rc="$2" want_seq="$3"; shift 3
    export STUB_SCENARIO=route
    invoke "$@"
    local seq; seq="$(paste -sd';' "$tmp/calls")"
    if [ "$rc" = "$want_rc" ] && [ "$seq" = "$want_seq" ]; then
      echo "ok   - $label"; pass=$((pass + 1))
    else
      echo "FAIL - $label: rc=$rc (want $want_rc)"
      echo "         ran:  $seq"
      echo "         want: $want_seq"
      sed 's/^/         /' "$tmp/err" | head -8
      fail=$((fail + 1))
    fi
    unset STUB_MIRROR STUB_ORIGIN STUB_TAG STUB_REPODIGESTS STUB_LINE
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

  run "a passing pull runs once" 0 1 pass "" quay.io/argoproj/argocd:v3.3.9
  says "...and pulls the image it was given" out "quay.io/argoproj/argocd:v3.3.9: Pulling from"

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
    'Error response from daemon: received unexpected HTTP status: 504 Gateway Timeout' \
    'Error response from daemon: received unexpected HTTP status: 500 Internal Server Error' \
    'Error response from daemon: Get "https://quay.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)' \
    'Error response from daemon: Get "https://ghcr.io/v2/": net/http: request canceled' \
    'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp 140.82.1.1:443: connect: connection refused' \
    'Error response from daemon: Get "https://quay.io/v2/": dial tcp: lookup quay.io on 127.0.0.53:53: no such host'; do
    run "retried: ${line##*: }" 0 2 flaky_once "$line" redis:8
  done

  run "several images are each pulled, in order" 0 2 pass "" a:1 b:2
  if [ "$(cat "$tmp/calls")" = "$(printf 'pull a:1\npull b:2')" ]; then
    echo "ok   - ...as plain \`docker pull <image>\`"; pass=$((pass + 1))
  else echo "FAIL - invoked: $(tr '\n' ';' < "$tmp/calls")"; fail=$((fail + 1)); fi
  run "the first image that fails for good stops the run" 1 1 real 'manifest unknown' a:1 b:2

  run "no arguments is a usage error, not a silent pass" 2 0 pass ""

  # ── The mirror (#6067) ──
  ecr='ecr-public.aws.com/docker/library/redis:8.2.3-alpine'
  mir='mirror.gcr.io/library/redis:8.2.3-alpine'
  dig='sha256:08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba'
  quota='Error response from daemon: toomanyrequests: Data limit exceeded'

  route "a docker/library image is pulled from the mirror and tagged to the exact ECR ref" 0 \
    "pull $mir;tag $mir $ecr" "$ecr"
  says "...and the notice names the mirror as the source" err "::notice title=Image served by mirror.gcr.io (#6067)::${ecr} ← ${mir}"
  says "...and says no digest was pinned to check" err "no digest is pinned"

  STUB_MIRROR=real STUB_LINE='Error response from daemon: manifest for mirror.gcr.io/library/redis:8.2.3-alpine not found: manifest unknown' \
    route "a mirror that does not have the tag falls back to ECR Public, untagged" 0 \
    "pull $mir;pull $ecr" "$ecr"
  says "...and the fallback is a warning that names both refs" err "falling back to ${ecr}"
  says "...and the notice names ECR Public as the source" err "::notice title=Image served by ECR Public (#6067)::${ecr}"

  STUB_MIRROR=flaky_always STUB_LINE="$quota" \
    route "a mirror that keeps limiting is retried to the ceiling, then ECR Public is tried" 0 \
    "pull $mir;pull $mir;pull $mir;pull $ecr" "$ecr"
  if grep -q '^::error' "$tmp/err"; then
    echo "FAIL - ...but the mirror's last failure is an ::error although ECR Public served it"; fail=$((fail + 1))
  else echo "ok   - ...and the mirror's last failure is not an ::error, because ECR Public served it"; pass=$((pass + 1)); fi

  STUB_MIRROR=real STUB_ORIGIN=real STUB_LINE='manifest unknown' \
    route "when both the mirror and ECR Public fail, the run fails" 1 \
    "pull $mir;pull $ecr" "$ecr"
  says "...with an ::error on the ECR ref" err "::error title=Image pull failed::${ecr}"

  STUB_TAG=fail \
    route "a failed retag falls back to ECR Public" 0 \
    "pull $mir;tag $mir $ecr;pull $ecr" "$ecr"

  STUB_REPODIGESTS="mirror.gcr.io/library/redis@$dig" \
    route "a pinned digest the mirror carries is verified, then the tag is written" 0 \
    "pull $mir;image inspect --format {{range .RepoDigests}}{{println .}}{{end}} $mir;tag $mir $ecr" "$ecr@$dig"
  says "...and the notice says the digest was verified" err "digest ${dig} verified"

  STUB_REPODIGESTS="mirror.gcr.io/library/redis@sha256:0000000000000000000000000000000000000000000000000000000000000000" \
    route "a pinned digest the mirror does NOT carry is never tagged; ECR Public is pulled by the pinned ref" 0 \
    "pull $mir;image inspect --format {{range .RepoDigests}}{{println .}}{{end}} $mir;pull $ecr@$dig" "$ecr@$dig"
  says "...and it says the digest did not match" err "does not carry the pinned digest"

  STUB_REPODIGESTS="mirror.gcr.io/library/redis-other@$dig" \
    route "a matching digest under ANOTHER repository does not count" 0 \
    "pull $mir;image inspect --format {{range .RepoDigests}}{{println .}}{{end}} $mir;pull $ecr@$dig" "$ecr@$dig"

  for ref in \
    'quay.io/argoproj/argocd:v3.3.9' \
    'ghcr.io/dexidp/dex:v2.45.1' \
    'ecr-public.aws.com/docker/other/redis:8.2.3-alpine' \
    'ecr-public.aws.com/docker/library/bitnami/redis:8' \
    'public.ecr.aws/docker/library/redis:8.2.3-alpine' \
    'docker.io/library/redis:8.2.3-alpine' \
    "ecr-public.aws.com/docker/library/redis@$dig" \
    'xecr-public.aws.com/docker/library/redis:8'; do
    route "NOT mapped, pulled as given: $ref" 0 "pull $ref" "$ref"
  done

  route "a mixed list maps only the docker/library image, in order" 0 \
    "pull quay.io/argoproj/argocd:v3.3.9;pull $mir;tag $mir $ecr;pull ghcr.io/dexidp/dex:v2.45.1" \
    quay.io/argoproj/argocd:v3.3.9 "$ecr" ghcr.io/dexidp/dex:v2.45.1

  # ── Mutations: each must make this self-test FAIL ──
  # A self-test that cannot fail proves nothing. Each mutant is this file with ONE line of the main
  # body changed; a sed that matched nothing is itself a failure, or the mutant would be the original.
  # shellcheck disable=SC2016 # each sed expression names the script's own `$var` text literally
  if [ -z "${DOCKER_PULL_RETRY_MUTANT:-}" ]; then
    mutate() { # LABEL SED-EXPRESSION
      local m="$tmp/mutant.sh"
      sed "/^# ── main ─/,\$ $2" "$self" > "$m"
      if cmp -s "$self" "$m"; then
        echo "FAIL - mutant \"$1\": the sed changed nothing, so it tests nothing"; fail=$((fail + 1)); return
      fi
      if DOCKER_PULL_RETRY_MUTANT=1 bash "$m" --self-test >/dev/null 2>&1; then
        echo "FAIL - mutant \"$1\" passes the self-test"; fail=$((fail + 1))
      else echo "ok   - mutant \"$1\" fails the self-test"; pass=$((pass + 1)); fi
    }
    mutate "the prefix is matched anywhere in the ref" 's|"\$ECR_LIBRARY"?\*) rest="\${1#"|*"$ECR_LIBRARY"?*) rest="${1#*"|'
    mutate "a nested name is mapped" 's|\*/\*) return 1 ;;|NEVER) return 1 ;;|'
    mutate "the digest check is skipped" 's|if grep -qxF -- "\$want" <<<"\$digests"; then|if true; then|'
    mutate "the retag is dropped" 's|if docker tag "\$mirror" "\$image"; then|if true; then|'
    mutate "a mirror failure ends the run" 's|^  if \[ "\$PULL_RC" -eq 0 \]; then$|  [ "$PULL_RC" -eq 0 ] \|\| { FETCH_RC=$PULL_RC; return 0; }; if true; then|'
  fi

  echo
  if [ "$fail" -eq 0 ]; then echo "docker-pull-retry self-test: all $pass passed"; exit 0; fi
  echo "docker-pull-retry self-test: $fail of $((pass + fail)) FAILED"; exit 1
fi

# ── main ──────────────────────────────────────────────────────────────────────────────────────────

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

# Pull image $1 until it succeeds, a non-transient failure occurs, or the attempts run out, and set
# PULL_RC to docker's exit code. $2 is the annotation level of a final failure: `error`, or `warning`
# when another source is still to be tried. Always returns 0 — see the self-test on errexit.
pull_one() {
  local image="$1" level="$2" attempt=1 rc line backoff
  while :; do
    # `if` keeps a failing pull from ending the script when it runs under `bash -e`.
    if docker pull "$image" >"$work/out" 2>&1; then rc=0; else rc=$?; fi
    cat "$work/out"
    if [ "$rc" -eq 0 ]; then
      if [ "$attempt" -gt 1 ]; then
        echo "::warning title=Image pull retried (#6044)::${image}: succeeded on attempt ${attempt}/${attempts} after $((attempt - 1)) transient failure(s). Nothing failed, but the registry is limiting or flaking — see the warnings above." >&2
      fi
      PULL_RC=0; return 0
    fi
    if ! line="$(transient_line "$work/out")"; then
      echo "::${level} title=Image pull failed::${image}: docker pull exited ${rc}, and that is not a rate limit or a transport error — not retrying." >&2
      PULL_RC=$rc; return 0
    fi
    line="${line//%/%25}"
    if [ "$attempt" -ge "$attempts" ]; then
      echo "::${level} title=Image pull failed (#6044)::${image}: could not pull in ${attempts} attempts. This is a PULL failure, not a test failure. Last error: ${line}" >&2
      PULL_RC=$rc; return 0
    fi
    # The base is a variable only so --self-test can drive it to zero; CI leaves it at 15s, so five
    # attempts wait 15+30+45+60s — long enough for a per-second anonymous limit to clear.
    backoff=$((attempt * ${DOCKER_PULL_RETRY_SLEEP_BASE:-15}))
    echo "::warning title=Image pull retried (#6044)::${image}: attempt ${attempt}/${attempts} failed on a rate limit or transport error — retrying in ${backoff}s. ${line}" >&2
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
}

# Print the mirror.gcr.io reference to pull for image $1 — its tag, without any digest — or return
# 1 when $1 is not mapped: not under ECR_LIBRARY, a nested name, or a digest with no tag.
mirror_ref() {
  local rest
  case "$1" in
    "$ECR_LIBRARY"?*) rest="${1#"$ECR_LIBRARY"}" ;;
    *) return 1 ;;
  esac
  rest="${rest%%@*}"
  case "$rest" in
    */*) return 1 ;;
    *:?*) printf '%s%s\n' "$MIRROR_LIBRARY" "$rest" ;;
    *) return 1 ;;
  esac
}

# Check a pinned digest against the pulled mirror image and write the tag the chart renders. Sets
# SERVED=1 when image $1 (the ECR reference as given) now exists in docker from mirror ref $2, and 0
# otherwise, having said why. Always returns 0 — see the self-test on errexit.
retag_from_mirror() {
  local image="$1" mirror="$2" digest="" digests want check
  SERVED=0
  if [ "${image#*@}" != "$image" ]; then
    digest="${image#*@}"
    image="${image%@*}"
    if ! digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$mirror" 2>&1)"; then
      echo "::warning title=Mirror digest unreadable (#6067)::${mirror}: could not read its RepoDigests (${digests//$'\n'/ }) — falling back to ${1}." >&2
      return 0
    fi
    want="${mirror%:*}@${digest}"
    if grep -qxF -- "$want" <<<"$digests"; then
      check="digest ${digest} verified against the mirror's RepoDigests"
    else
      echo "::warning title=Mirror digest mismatch (#6067)::${mirror} does not carry the pinned digest ${digest} (it has: ${digests//$'\n'/ }) — not tagging it; falling back to ${1}." >&2
      return 0
    fi
  else
    check="no digest is pinned, so the mirror's tag is trusted to be the same Docker Official Image"
  fi
  if docker tag "$mirror" "$image"; then
    echo "::notice title=Image served by mirror.gcr.io (#6067)::${image} ← ${mirror}; ${check}." >&2
    SERVED=1
  else
    echo "::warning title=Mirror retag failed (#6067)::docker tag ${mirror} ${image} failed — falling back to ${1}." >&2
  fi
}

# Put image $1 in docker under exactly that reference — from the mirror when it is mapped and the
# mirror serves it, otherwise from the reference itself — and set FETCH_RC. Always returns 0.
fetch_one() {
  local image="$1" mirror
  if ! mirror="$(mirror_ref "$image")"; then
    pull_one "$image" error
    FETCH_RC=$PULL_RC; return 0
  fi
  pull_one "$mirror" warning
  if [ "$PULL_RC" -eq 0 ]; then
    retag_from_mirror "$image" "$mirror"
    if [ "$SERVED" -eq 1 ]; then FETCH_RC=0; return 0; fi
  else
    echo "::warning title=Mirror pull failed (#6067)::${mirror}: docker pull exited ${PULL_RC} — falling back to ${image} on anonymous ECR Public." >&2
  fi
  pull_one "$image" error
  FETCH_RC=$PULL_RC
  if [ "$FETCH_RC" -eq 0 ]; then
    echo "::notice title=Image served by ECR Public (#6067)::${image} came from anonymous ECR Public, not the mirror — see the warnings above." >&2
  fi
  return 0
}

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <image>... | --self-test" >&2
  exit 2
fi

# A plain call, never `fetch_one … || exit`: inside a `||` list bash runs the function body with
# errexit off, and the self-test's `bash -e` could then no longer catch an unguarded pull.
for image in "$@"; do
  fetch_one "$image"
  [ "$FETCH_RC" -eq 0 ] || exit "$FETCH_RC"
done
