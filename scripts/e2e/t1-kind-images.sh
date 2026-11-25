#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# T1's ArgoCD images as ONE single-platform archive that `kind load image-archive` imports (#7698).
#
# USAGE
#   t1-kind-images.sh key <image-list>
#       print the actions/cache key for this list on this runner's docker platform
#   t1-kind-images.sh archive <image-list> <out.tar>
#       pull every image (scripts/ci/docker-pull-retry.sh: mirror first, retrying a rate limit) and
#       `docker save` them for the docker server's own platform into <out.tar>
#   t1-kind-images.sh check-node <kind-node-container> <image-list>
#       assert every image is in the node's containerd (namespace k8s.io), naming each one missing
#   t1-kind-images.sh --self-test
#
# <image-list> is one reference per line, as test/e2e/cmd/argoimages prints it; blank lines and `#`
# comments are ignored, and an empty list is an error.
#
# WHY IT EXISTS. #6044 pulled the chart's images on the runner and had the T1 test run `kind load
# docker-image`. On the ubuntu26 runner image Docker uses the containerd image store, where `docker
# save` of a multi-platform image writes the whole index — every platform's manifest — but holds
# only the blobs of the platform it pulled. kind imports with `ctr images import --all-platforms`,
# which then fails on the first blob it cannot find (`ctr: content digest sha256:…: not found`).
# Every load failed that way, T1's test reported it only as a pre-load warning, and the kubelet
# pulled redis from anonymous ECR Public itself — the exact 429 #6044 existed to stop (#7698, runs
# 45682340518 and the #7524 queue build). A save with `--platform` writes only the platform docker
# holds, so the import has every blob it is asked for.
#
# THE CACHE. ci.yml's provision-e2e job restores <out.tar> from actions/cache under `key`, and only
# pulls on a miss. The key is the image list itself (plus the platform and a format version), so a
# chart bump that changes an image changes the key. A Mergify queue build is a pull_request run, and
# a cache it saved would be scoped to its own refs/pull/N/merge, which no later run can read — so
# the queue job only RESTORES, and ci.yml's `t1-kind-images` job SAVES from main (push + nightly),
# whose caches every pull_request run may read.
#
# WHAT IT DOES NOT HIDE. A pull that fails after its retries fails this script with docker-pull-
# retry's own `::error` naming the image. A save that fails, or writes an archive with no image
# index in it, is an `::error` naming every image, and <out.tar> is not written — so a cache can
# never be seeded with a broken archive.

set -uo pipefail

KEY_VERSION=v1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── --self-test ───────────────────────────────────────────────────────────────────────────────────
#
# A stub `docker` on PATH answers `version`, `info`, `save` and `exec` from env, and appends every
# invocation to a file; a stub puller stands in for docker-pull-retry.sh. Every case runs the script
# under `bash -e` (GitHub's default shell). The run's exit code IS the test.
# shellcheck disable=SC2016,SC2034 # each case is a single-quoted expression `check` evals later
if [ "${1:-}" = "--self-test" ]; then
  self="$HERE/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  pass=0 fail=0
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_CALLS"
case "$1" in
  version) echo "${STUB_PLATFORM:-linux/amd64}"; exit 0 ;;
  info) echo "${STUB_DRIVER:-[[\"driver-type\",\"io.containerd.snapshotter.v1\"]]}"; exit 0 ;;
  save)
    [ "${STUB_SAVE:-pass}" = fail ] && { echo "Error response from daemon: boom" >&2; exit 1; }
    out=""; while [ "$#" -gt 0 ]; do [ "$1" = -o ] && { out="$2"; shift; }; shift; done
    d="$(mktemp -d)"; echo '{}' > "$d/${STUB_ENTRY:-index.json}"
    tar -cf "$out" -C "$d" . ; rm -rf "$d"; exit 0 ;;
  exec) printf '%s\n' ${STUB_NODE_IMAGES:-}; exit 0 ;;
esac
echo "stub: unexpected docker $*" >&2; exit 99
STUB
  cat > "$tmp/bin/puller" <<'STUB'
#!/usr/bin/env bash
echo "PULL $*" >> "$STUB_CALLS"
[ "${STUB_PULL:-pass}" = pass ] && exit 0
echo "::error title=Image pull failed::$1: could not pull" >&2; exit 1
STUB
  chmod +x "$tmp/bin/docker" "$tmp/bin/puller"

  # invoke ARGS... — run under `bash -e`; sets rc and seq (the invocations, joined with `;`).
  invoke() {
    : > "$tmp/calls"; rc=0
    (cd "$tmp" && env PATH="$tmp/bin:$PATH" STUB_CALLS="$tmp/calls" T1_KIND_IMAGES_PULL="$tmp/bin/puller" \
      bash -e "$self" "$@" >"$tmp/out" 2>"$tmp/err") || rc=$?
    seq="$(paste -sd';' "$tmp/calls")"
  }
  ok() { echo "ok   - $1"; pass=$((pass + 1)); }
  bad() { echo "FAIL - $1"; sed 's/^/         /' "$tmp/err" | head -6; fail=$((fail + 1)); }
  check() { if eval "$2"; then ok "$1"; else bad "$1 (rc=$rc seq=$seq)"; fi; }

  printf 'quay.io/argoproj/argocd:v3.3.9\nghcr.io/dexidp/dex:v2.45.1\n' > "$tmp/list"
  printf '# a comment\n\nghcr.io/dexidp/dex:v2.45.1\n  quay.io/argoproj/argocd:v3.3.9  \n' > "$tmp/list-noisy"
  printf 'quay.io/argoproj/argocd:v3.3.10\nghcr.io/dexidp/dex:v2.45.1\n' > "$tmp/list-bumped"
  printf '# nothing\n\n' > "$tmp/list-empty"

  # ── key ──
  invoke key "$tmp/list"; k1="$(cat "$tmp/out")"
  check "key names the format version and the docker platform" '[ "$rc" = 0 ] && [[ "$k1" == t1-kind-images-v1-linux-amd64-* ]]'
  invoke key "$tmp/list-noisy"; k2="$(cat "$tmp/out")"
  check "key ignores order, blank lines, comments and padding" '[ "$k1" = "$k2" ]'
  invoke key "$tmp/list-bumped"; k3="$(cat "$tmp/out")"
  check "key changes when an image changes" '[ "$rc" = 0 ] && [ "$k1" != "$k3" ]'
  STUB_PLATFORM=linux/arm64 invoke key "$tmp/list"; k4="$(cat "$tmp/out")"
  check "key changes with the platform" '[ "$k1" != "$k4" ]'
  invoke key "$tmp/list-empty"
  check "an empty list is an error, not a key" '[ "$rc" != 0 ] && [ ! -s "$tmp/out" ]'

  # ── archive ──
  out="$tmp/images.tar"
  rm -f "$out"; invoke archive "$tmp/list" "$out"
  check "containerd store: pulls every image, then saves ONLY the server's platform" \
    '[ "$rc" = 0 ] && [[ "$seq" == "PULL ghcr.io/dexidp/dex:v2.45.1 quay.io/argoproj/argocd:v3.3.9;version"*";save --platform linux/amd64 -o "*" ghcr.io/dexidp/dex:v2.45.1 quay.io/argoproj/argocd:v3.3.9" ]] && [ -s "$out" ]'
  rm -f "$out"; STUB_DRIVER='[["Backing Filesystem","extfs"]]' invoke archive "$tmp/list" "$out"
  check "classic store: saves without --platform (it holds one platform already)" \
    '[ "$rc" = 0 ] && [[ "$seq" == *";save -o "* ]] && [[ "$seq" != *"--platform"* ]] && [ -s "$out" ]'
  rm -f "$out"; STUB_ENTRY=manifest.json invoke archive "$tmp/list" "$out"
  check "a docker-format archive (manifest.json) is accepted" '[ "$rc" = 0 ] && [ -s "$out" ]'
  rm -f "$out"; STUB_PULL=fail invoke archive "$tmp/list" "$out"
  check "a failed pull fails the run before any save, and writes no archive" \
    '[ "$rc" != 0 ] && [[ "$seq" != *save* ]] && [ ! -e "$out" ]'
  rm -f "$out"; STUB_SAVE=fail invoke archive "$tmp/list" "$out"
  check "a failed save is an ::error naming every image, and writes no archive" \
    '[ "$rc" != 0 ] && [ ! -e "$out" ] && grep -q "::error title=T1 image archive failed" "$tmp/err" && grep -q "quay.io/argoproj/argocd:v3.3.9" "$tmp/err"'
  rm -f "$out"; STUB_ENTRY=junk.txt invoke archive "$tmp/list" "$out"
  check "an archive with no image index is refused, and not written" \
    '[ "$rc" != 0 ] && [ ! -e "$out" ] && grep -q "no image index" "$tmp/err"'
  invoke archive "$tmp/list-empty" "$out"
  check "archive of an empty list is an error" '[ "$rc" != 0 ] && [[ "$seq" != *PULL* ]]'
  invoke archive "$tmp/list"
  check "archive without an output path is a usage error" '[ "$rc" = 2 ]'

  # ── check-node ──
  printf 'redis:8\nquay.io/argoproj/argocd:v3.3.9\n' > "$tmp/list-short"
  STUB_NODE_IMAGES="docker.io/library/redis:8 quay.io/argoproj/argocd:v3.3.9 registry.k8s.io/pause:3.10" \
    invoke check-node kind-node "$tmp/list-short"
  check "every image present (a short Docker Hub ref normalised) passes" \
    '[ "$rc" = 0 ] && [[ "$seq" == "exec kind-node ctr --namespace=k8s.io images ls -q" ]]'
  STUB_NODE_IMAGES="docker.io/library/redis:8" invoke check-node kind-node "$tmp/list-short"
  check "a missing image fails, and the ::error names it" \
    '[ "$rc" = 1 ] && grep -q "::error title=Image not in the kind node::quay.io/argoproj/argocd:v3.3.9" "$tmp/err"'
  printf 'quay.io/argoproj/argocd:v3.3.9\n' > "$tmp/list-one"
  STUB_NODE_IMAGES="quay.io/argoproj/argocd:v3.3.9-rc1 xquay.io/argoproj/argocd:v3.3.9" invoke check-node kind-node "$tmp/list-one"
  check "a prefix match is not a match" '[ "$rc" = 1 ]'

  invoke
  check "no subcommand is a usage error" '[ "$rc" = 2 ]'

  echo
  if [ "$fail" -eq 0 ]; then echo "t1-kind-images self-test: all $pass passed"; exit 0; fi
  echo "t1-kind-images self-test: $fail of $((pass + fail)) FAILED"; exit 1
fi

# ── main ──────────────────────────────────────────────────────────────────────────────────────────

usage() { echo "usage: $0 key <list> | archive <list> <out.tar> | check-node <node> <list> | --self-test" >&2; exit 2; }

# Read the image list $1 into the global array IMAGES, sorted and de-duplicated. Exits on an empty
# or unreadable list: a pre-load of nothing would pass while loading nothing.
read_list() {
  [ -r "$1" ] || { echo "::error title=T1 image list::$1 is not readable" >&2; exit 1; }
  mapfile -t IMAGES < <(sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" | grep -v '^$' | LC_ALL=C sort -u)
  [ "${#IMAGES[@]}" -gt 0 ] || { echo "::error title=T1 image list::$1 lists no images" >&2; exit 1; }
}

# The docker server's platform, as os/arch.
server_platform() { docker version --format '{{.Server.Os}}/{{.Server.Arch}}'; }

# Print the reference as containerd names it: a Docker Hub short name gains `docker.io/` and, for a
# single-segment name, `library/` — the names `ctr images ls` prints after `kind load`.
normalize_ref() {
  local ref="$1" first="${1%%/*}"
  if [ "$first" = "$ref" ]; then
    printf 'docker.io/library/%s\n' "$ref"
  elif [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then
    printf '%s\n' "$ref"
  else
    printf 'docker.io/%s\n' "$ref"
  fi
}

cmd_key() {
  read_list "$1"
  local platform sum
  platform="$(server_platform)" || { echo "::error title=T1 image key::cannot read the docker server's platform" >&2; exit 1; }
  sum="$(printf '%s\n' "${IMAGES[@]}" | sha256sum | cut -c1-32)"
  printf 't1-kind-images-%s-%s-%s\n' "$KEY_VERSION" "${platform//\//-}" "$sum"
}

cmd_archive() {
  local list="$1" out="$2" platform staging rc=0
  read_list "$list"
  # A failed pull has already printed an ::error naming its image; stop on it, before any save.
  "${T1_KIND_IMAGES_PULL:-$HERE/../ci/docker-pull-retry.sh}" "${IMAGES[@]}" || exit $?
  platform="$(server_platform)" || { echo "::error title=T1 image archive failed::cannot read the docker server's platform" >&2; exit 1; }
  staging="$out.partial.$$"
  rm -f "$staging"
  # The containerd image store saves the WHOLE index unless told a platform, and kind's
  # `ctr import --all-platforms` then fails on blobs that were never pulled (see the header). The
  # classic store holds one platform per tag already, and older daemons may not take --platform.
  if docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; then
    echo "t1-kind-images: containerd image store — saving ${#IMAGES[@]} image(s) for ${platform} only" >&2
    docker save --platform "$platform" -o "$staging" "${IMAGES[@]}" || rc=$?
  else
    echo "t1-kind-images: classic image store — saving ${#IMAGES[@]} image(s)" >&2
    docker save -o "$staging" "${IMAGES[@]}" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    rm -f "$staging"
    echo "::error title=T1 image archive failed::docker save exited ${rc} for: ${IMAGES[*]}" >&2
    exit "$rc"
  fi
  if ! tar -tf "$staging" 2>/dev/null | grep -Eq '^(\./)?(index|manifest)\.json$'; then
    rm -f "$staging"
    echo "::error title=T1 image archive failed::docker save wrote an archive with no image index (index.json / manifest.json) for: ${IMAGES[*]}" >&2
    exit 1
  fi
  mv -f "$staging" "$out"
  echo "t1-kind-images: wrote $out ($(du -h "$out" | cut -f1)) — ${IMAGES[*]}" >&2
}

cmd_check_node() {
  local node="$1" list="$2" have missing=0 img
  read_list "$list"
  have="$(docker exec "$node" ctr --namespace=k8s.io images ls -q)" || {
    echo "::error title=Image not in the kind node::cannot list images in ${node}" >&2; exit 1; }
  for img in "${IMAGES[@]}"; do
    if grep -qxF -- "$(normalize_ref "$img")" <<<"$have"; then
      echo "ok: ${img} is in ${node}"
    else
      echo "::error title=Image not in the kind node::${img} was not imported into ${node} (containerd k8s.io namespace)" >&2
      missing=1
    fi
  done
  return "$missing"
}

case "${1:-}" in
  key) [ "$#" -eq 2 ] || usage; cmd_key "$2" ;;
  archive) [ "$#" -eq 3 ] || usage; cmd_archive "$2" "$3" ;;
  check-node) [ "$#" -eq 3 ] || usage; cmd_check_node "$2" "$3" || exit 1 ;;
  *) usage ;;
esac
