#!/usr/bin/env bash
set -euo pipefail

GHCR_IMAGE="ghcr.io/bobikenobi12/tendril"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_SHA=$(git -C "${REPO_ROOT}" rev-parse --short HEAD)

declare -A TENDRILS=(
  ["prod-eu-west-1"]="eu-west-1"
  ["beta-eu-west-1"]="eu-west-1"
  ["dev-eu-west-1"]="eu-west-1"
  ["dev-eu-central-1"]="eu-central-1"
)

TARGET="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    *) echo "Usage: $0 [--target prod|beta|dev|all]" >&2; exit 1 ;;
  esac
done

should_deploy() {
  local key="$1"
  case "$TARGET" in
    all)  return 0 ;;
    prod) [[ "$key" == prod-* ]] ;;
    beta) [[ "$key" == beta-* ]] ;;
    dev)  [[ "$key" == dev-* ]] ;;
    *)    echo "Unknown target: $TARGET" >&2; exit 1 ;;
  esac
}

echo "==> Building Docker image (${GIT_SHA})..."
docker build \
  -f "${REPO_ROOT}/apps/tendril/Dockerfile" \
  -t "${GHCR_IMAGE}:latest" \
  -t "${GHCR_IMAGE}:${GIT_SHA}" \
  --build-arg VERSION=dev \
  "${REPO_ROOT}"

echo "==> Pushing to GHCR..."
docker push "${GHCR_IMAGE}:latest"
docker push "${GHCR_IMAGE}:${GIT_SHA}"

FAILED=0
DEPLOYED=0

for KEY in "${!TENDRILS[@]}"; do
  should_deploy "$KEY" || continue

  REGION="${TENDRILS[$KEY]}"
  CLUSTER="tendril-dev-${KEY}-cluster"
  SERVICE="tendril-dev-${KEY}-service"

  echo "==> Deploying ${KEY} (${REGION})..."
  if aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --force-new-deployment \
    --region "$REGION" \
    --no-cli-pager > /dev/null; then
    DEPLOYED=$((DEPLOYED + 1))
  else
    echo "    FAILED: ${KEY}" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo "==> Done. Deployed: ${DEPLOYED}, Failed: ${FAILED}"
[ "$FAILED" -eq 0 ] || exit 1
