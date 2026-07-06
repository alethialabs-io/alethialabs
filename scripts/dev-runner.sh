#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Bring up one or two provisioning runners locally, pointed at the native `dev:up`
# console (:3000). One command: `pnpm dev:runner`.
#
# Why this exists: the only runner wiring before this was the compose `runner`
# service in `pnpm compose:up:full`, which targets the dockerized console
# (app:3000) and needs the heavy prod image. Nothing connected a runner to the
# everyday native console. This script fills that gap — it self-registers runners
# against the running `dev:up` console so the Fleet page and job execution can be
# exercised end-to-end.
#
# Knobs (env vars):
#   RUNNERS=2          how many runners to start (default 1)
#   MODE=docker        native (go build, fast) | docker (full tofu+CLI toolchain).
#                      Default: native if `go` is on PATH, else docker.
#   CRED=self          bootstrap (auto self-register, default) | self (use creds)
#   PROVIDERS=aws,gcp  restrict claimable clouds (default: any)
#   SLOTS=2            concurrent jobs per runner (default 1)
#   REBUILD=1          (docker) rebuild the runner image even if present
#   RUNNER_CREDS=...   (CRED=self) "id1:token1,id2:token2" for >1 runner;
#                      falls back to .env's ALETHIA_RUNNER_ID/TOKEN for one runner
#   FORCE=1            tear down existing local runners and start fresh
#
# Follow logs:  pnpm dev:runner:logs   ·   Tear down:  pnpm dev:runner:down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCK=/tmp/alethia-dev-runner.lock
BIN=/tmp/alethia-dev-runner-bin           # compiled once, reused by all native runners
IMAGE=alethia-runner:dev
CONTAINER_PREFIX=alethia-runner
LOG_PREFIX=/tmp/alethia-dev-runner        # per-runner logs: ${LOG_PREFIX}-N.log

RUNNERS="${RUNNERS:-1}"
CRED="${CRED:-bootstrap}"
SLOTS="${SLOTS:-1}"

if [[ ! -f .env ]]; then
  echo "✗ no .env found — run: cp .env.example .env" >&2
  exit 1
fi

# ── Default MODE: native when the Go toolchain is present, else docker ──
if [[ -z "${MODE:-}" ]]; then
  if command -v go >/dev/null 2>&1; then MODE=native; else MODE=docker; fi
fi
case "$MODE" in native|docker) ;; *) echo "✗ MODE must be 'native' or 'docker' (got '$MODE')" >&2; exit 1 ;; esac
case "$CRED" in bootstrap|self) ;; *) echo "✗ CRED must be 'bootstrap' or 'self' (got '$CRED')" >&2; exit 1 ;; esac

# ── One set of local runners across windows (mirrors scripts/dev-up.sh) ──
# A second `pnpm dev:runner` no-ops and prints what's running. FORCE=1 tears the
# old runners down first. The lock persists after this script exits (runners run
# detached) and is removed by `pnpm dev:runner:down`.
# A lock with no live runner behind it is stale (e.g. the runner was killed when the
# console restarted) — reclaim it automatically rather than forcing the user to FORCE.
runners_alive() {
  if [[ -f "$LOCK/pids" ]]; then
    while read -r p; do [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null && return 0; done < "$LOCK/pids"
  fi
  docker ps -q --filter "name=${CONTAINER_PREFIX}-" 2>/dev/null | grep -q . && return 0
  return 1
}
if ! mkdir "$LOCK" 2>/dev/null; then
  if [[ "${FORCE:-}" == "1" ]]; then
    echo "↻ FORCE=1 — tearing down existing local runners…"
    bash scripts/dev-runner-down.sh || true
    mkdir "$LOCK"
  elif ! runners_alive; then
    echo "↻ Reclaiming stale runner lock (no live runner behind it)."
    bash scripts/dev-runner-down.sh >/dev/null 2>&1 || true
    mkdir "$LOCK"
  else
    echo "⏳ Local runners already up (MODE=$(cat "$LOCK/mode" 2>/dev/null || echo '?'))."
    if [[ -f "$LOCK/pids" ]]; then echo "   native pids: $(tr '\n' ' ' < "$LOCK/pids")"; fi
    docker ps --filter "name=${CONTAINER_PREFIX}-" --format '   container: {{.Names}} ({{.Status}})' 2>/dev/null || true
    echo "   Follow logs:  pnpm dev:runner:logs   ·   Restart: FORCE=1 pnpm dev:runner   ·   Stop: pnpm dev:runner:down"
    exit 0
  fi
fi
# Until launch succeeds, free the lock on any error so we don't strand an empty marker.
trap 'rm -rf "$LOCK"' EXIT
echo "$MODE" > "$LOCK/mode"

# Load the canonical dev env (storage creds, web origin, runner self creds).
set -a
# shellcheck disable=SC1091
source ./.env
set +a

WEB_ORIGIN="${ALETHIA_WEB_ORIGIN:-http://localhost:3000}"

# ── Preflight: the console must be up (it owns registration + the job queue) ──
if ! curl -fsS -o /dev/null --max-time 3 "$WEB_ORIGIN" 2>/dev/null; then
  echo "✗ console not reachable at $WEB_ORIGIN — start it first: pnpm dev:up" >&2
  exit 1
fi

# ── Preflight: bootstrap token must exist AND be loaded by the running console ──
# The console reads ALETHIA_RUNNER_BOOTSTRAP_TOKEN from .env at `dev:up` start, so a
# token we add now isn't live until the console restarts. Generate-and-stop in that
# case rather than launching runners that would 401 on every bootstrap.
if [[ "$CRED" == "bootstrap" ]]; then
  if [[ -z "${ALETHIA_RUNNER_BOOTSTRAP_TOKEN:-}" ]]; then
    TOKEN="$(openssl rand -hex 32)"
    printf '\n# Added by scripts/dev-runner.sh — shared secret for local runner self-registration.\nALETHIA_RUNNER_BOOTSTRAP_TOKEN=%s\n' "$TOKEN" >> .env
    echo "✓ generated ALETHIA_RUNNER_BOOTSTRAP_TOKEN and wrote it to .env"
    echo "↻ restart the console so it picks up the token, then re-run dev:runner:"
    echo "     FORCE=1 pnpm dev:up   &&   pnpm dev:runner"
    exit 0
  fi
  # The token is in .env — confirm the live console actually accepts it (a wrong
  # token returns 401). Probe with the real token + a throwaway instance id, then
  # delete the runner it mints (using the creds the probe returns) so the check
  # leaves no OFFLINE row behind.
  PROBE_BODY="$(mktemp)"
  PROBE_CODE="$(curl -s -o "$PROBE_BODY" -w '%{http_code}' --max-time 5 \
    -X POST "$WEB_ORIGIN/api/runners/bootstrap" \
    -H "Authorization: Bearer ${ALETHIA_RUNNER_BOOTSTRAP_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"instanceId":"dev-runner-preflight"}' 2>/dev/null || echo 000)"
  if [[ "$PROBE_CODE" == "401" ]]; then
    rm -f "$PROBE_BODY"
    echo "✗ the running console rejects the bootstrap token (HTTP 401)." >&2
    echo "  It was likely started before the token was added to .env. Restart it:" >&2
    echo "     FORCE=1 pnpm dev:up   &&   pnpm dev:runner" >&2
    exit 1
  elif [[ "$PROBE_CODE" == "200" ]]; then
    pid_id="$(grep -oE '"runner_id":"[^"]+"' "$PROBE_BODY" | head -1 | sed -E 's/.*:"([^"]+)"/\1/')"
    pid_tok="$(grep -oE '"runner_token":"[^"]+"' "$PROBE_BODY" | head -1 | sed -E 's/.*:"([^"]+)"/\1/')"
    if [[ -n "$pid_id" && -n "$pid_tok" ]]; then
      curl -s -o /dev/null --max-time 5 -X DELETE "$WEB_ORIGIN/api/runners/$pid_id" \
        -H "X-Runner-ID: $pid_id" -H "X-Runner-Token: $pid_tok" 2>/dev/null || true
    fi
  else
    echo "⚠ bootstrap preflight returned HTTP $PROBE_CODE (expected 200) — continuing anyway." >&2
  fi
  rm -f "$PROBE_BODY"
fi

# ── CRED=self: resolve a runner_id:runner_token pair per runner ──
declare -a SELF_IDS=() SELF_TOKENS=()
if [[ "$CRED" == "self" ]]; then
  if [[ -n "${RUNNER_CREDS:-}" ]]; then
    IFS=',' read -ra _pairs <<< "$RUNNER_CREDS"
    for p in "${_pairs[@]}"; do
      SELF_IDS+=("${p%%:*}"); SELF_TOKENS+=("${p#*:}")
    done
  elif [[ -n "${ALETHIA_RUNNER_ID:-}" && -n "${ALETHIA_RUNNER_TOKEN:-}" ]]; then
    SELF_IDS+=("$ALETHIA_RUNNER_ID"); SELF_TOKENS+=("$ALETHIA_RUNNER_TOKEN")
  fi
  if (( ${#SELF_IDS[@]} == 0 )); then
    echo "✗ CRED=self needs creds: set ALETHIA_RUNNER_ID/ALETHIA_RUNNER_TOKEN in .env," >&2
    echo "  or pass RUNNER_CREDS=\"id1:token1,id2:token2\". Mint them via the Fleet 'Register' tab." >&2
    exit 1
  fi
  if (( ${#SELF_IDS[@]} < RUNNERS )); then
    echo "✗ CRED=self: only ${#SELF_IDS[@]} cred pair(s) for RUNNERS=$RUNNERS." >&2
    echo "  Provide more via RUNNER_CREDS, or use the default CRED=bootstrap." >&2
    exit 1
  fi
fi

OPERATOR="$([[ "$CRED" == "bootstrap" ]] && echo managed || echo self)"

# ── Docker mode: build the runner image once (it bakes tofu + cloud CLIs + templates) ──
if [[ "$MODE" == "docker" ]]; then
  if ! docker info >/dev/null 2>&1; then
    echo "✗ Docker daemon not responding — open Docker Desktop and retry." >&2
    exit 1
  fi
  if [[ "${REBUILD:-}" == "1" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "→ building $IMAGE (first build is slow — bakes OpenTofu + cloud CLIs)…"
    docker build -f apps/runner/Dockerfile -t "$IMAGE" .
  fi
fi

# ── Native mode: compile the runner once; all instances share the binary ──
if [[ "$MODE" == "native" ]]; then
  echo "→ building runner binary…"
  ( cd apps/runner && go build -o "$BIN" ./cmd/runner )
  if ! command -v tofu >/dev/null 2>&1 && ! command -v terraform >/dev/null 2>&1; then
    echo "⚠ neither 'tofu' nor 'terraform' on PATH — native runners register and claim"
    echo "  jobs, but provisioning jobs that shell out to OpenTofu will fail."
    echo "  For full job execution use:  MODE=docker pnpm dev:runner"
  fi
fi

: > "$LOCK/pids"

# ── Launch RUNNERS instances ──
for i in $(seq 1 "$RUNNERS"); do
  LOG="${LOG_PREFIX}-${i}.log"
  : > "$LOG"

  if [[ "$MODE" == "docker" ]]; then
    name="${CONTAINER_PREFIX}-${i}"
    docker rm -f "$name" >/dev/null 2>&1 || true
    args=(
      -d --name "$name" --hostname "$name"
      --add-host host.docker.internal:host-gateway
      --restart unless-stopped
      -e ALETHIA_WEB_ORIGIN="${WEB_ORIGIN/localhost/host.docker.internal}"
      -e ALETHIA_STORAGE_ENDPOINT="${ALETHIA_STORAGE_ENDPOINT/localhost/host.docker.internal}"
      -e ALETHIA_STORAGE_REGION="${ALETHIA_STORAGE_REGION:-}"
      -e ALETHIA_STORAGE_ACCESS_KEY_ID="${ALETHIA_STORAGE_ACCESS_KEY_ID:-}"
      -e ALETHIA_STORAGE_SECRET_ACCESS_KEY="${ALETHIA_STORAGE_SECRET_ACCESS_KEY:-}"
      -e ALETHIA_RUNNER_OPERATOR="$OPERATOR"
      -e ALETHIA_RUNNER_SLOTS="$SLOTS"
    )
    [[ -n "${PROVIDERS:-}" ]] && args+=( -e ALETHIA_RUNNER_PROVIDERS="$PROVIDERS" )
    if [[ "$CRED" == "bootstrap" ]]; then
      args+=( -e ALETHIA_RUNNER_BOOTSTRAP_TOKEN="$ALETHIA_RUNNER_BOOTSTRAP_TOKEN"
              -e ALETHIA_RUNNER_INSTANCE_ID="dev-runner-${i}" )
    else
      args+=( -e ALETHIA_RUNNER_ID="${SELF_IDS[$((i-1))]}"
              -e ALETHIA_RUNNER_TOKEN="${SELF_TOKENS[$((i-1))]}" )
    fi
    docker run "${args[@]}" "$IMAGE" >/dev/null
    echo "$name" >> "$LOCK/pids"
    echo "→ runner $i up: container $name  (logs: docker logs -f $name)"
  else
    env_args=(
      ALETHIA_WEB_ORIGIN="$WEB_ORIGIN"
      ALETHIA_STORAGE_ENDPOINT="${ALETHIA_STORAGE_ENDPOINT:-}"
      ALETHIA_STORAGE_REGION="${ALETHIA_STORAGE_REGION:-}"
      ALETHIA_STORAGE_ACCESS_KEY_ID="${ALETHIA_STORAGE_ACCESS_KEY_ID:-}"
      ALETHIA_STORAGE_SECRET_ACCESS_KEY="${ALETHIA_STORAGE_SECRET_ACCESS_KEY:-}"
      ALETHIA_RUNNER_OPERATOR="$OPERATOR"
      ALETHIA_RUNNER_SLOTS="$SLOTS"
    )
    [[ -n "${PROVIDERS:-}" ]] && env_args+=( ALETHIA_RUNNER_PROVIDERS="$PROVIDERS" )
    if [[ "$CRED" == "bootstrap" ]]; then
      env_args+=( ALETHIA_RUNNER_BOOTSTRAP_TOKEN="$ALETHIA_RUNNER_BOOTSTRAP_TOKEN"
                  ALETHIA_RUNNER_INSTANCE_ID="dev-runner-${i}"
                  ALETHIA_RUNNER_ID="" ALETHIA_RUNNER_TOKEN="" )
    else
      env_args+=( ALETHIA_RUNNER_ID="${SELF_IDS[$((i-1))]}"
                  ALETHIA_RUNNER_TOKEN="${SELF_TOKENS[$((i-1))]}" )
    fi
    # Run from apps/runner so resolveSpecTemplatesDir()'s native fallback
    # (../../infra/templates/project) resolves; per-job workdirs use os.MkdirTemp("")
    # (temp dir, not CWD), so this doesn't litter the source tree.
    nohup env "${env_args[@]}" sh -c "cd '$ROOT/apps/runner' && exec '$BIN'" \
      >> "$LOG" 2>&1 < /dev/null &
    pid=$!
    disown "$pid" 2>/dev/null || true
    echo "$pid" >> "$LOCK/pids"
    echo "→ runner $i up: pid $pid  (logs: tail -f $LOG)"
  fi
done

# Launch succeeded — keep the lock so dev:runner:down can find these runners.
trap - EXIT

echo "$RUNNERS" > "$LOCK/count"
echo "✓ $RUNNERS runner(s) up (MODE=$MODE, CRED=$CRED, operator=$OPERATOR) → $WEB_ORIGIN"
echo "  Fleet page lists them ONLINE within ~10s. Logs: pnpm dev:runner:logs · Stop: pnpm dev:runner:down"
