#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Hermetic provisioning-E2E keystone runner.
#
# Drives the REAL provisioner.RunDeployV2 spine — plan -> verify gate -> signed
# evidence receipt -> apply -> ConfigureKubeconfig -> WaitClusterReady ->
# WaitPodToAPIServer -> ArgoCD — against a genuine local `kind` (Kubernetes-IN-
# Docker) cluster, with NO cloud account and NO cloud credentials. The kind cluster
# is created + torn down IN-TOFU by the `local` project template
# (infra/templates/project/local) via the tehcyx/kind provider; teardown is
# guaranteed by the test's t.Cleanup (RunDestroy, with a `docker rm` fallback).
#
# This is the seam the later merge-queue T1 CI job (task A1-T1) will call. It is NOT
# wired into CI in this PR.
#
# Prereqs (the Go test SKIPS cleanly if any is missing, so this script surfaces that):
#   - docker daemon running (kind needs it)
#   - tofu on PATH
#   - kubectl + helm on PATH (the ArgoCD tail of the spine shells out to them)
#
# Usage:
#   scripts/e2e/provision-hermetic.sh            # run the kind E2E keystone
#   VERBOSE=1 scripts/e2e/provision-hermetic.sh  # stream the full provisioner log
#
# Env knobs:
#   ALETHIA_CLUSTER_READY_TIMEOUT  reachability-gate timeout (test sets 3m by default)
#   GOTEST_TIMEOUT                 overall `go test` timeout (default 20m)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CORE_DIR="$REPO_ROOT/packages/core"
GOTEST_TIMEOUT="${GOTEST_TIMEOUT:-20m}"

echo "==> Preflight"
missing=0
for bin in docker tofu kubectl helm; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "    ✓ $bin"
  else
    echo "    ✗ $bin (missing)"
    missing=1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "    ✗ docker daemon not reachable"
  missing=1
else
  echo "    ✓ docker daemon reachable"
fi
if [ "$missing" -ne 0 ]; then
  echo "==> One or more prerequisites are missing; the Go test will skip. Aborting." >&2
  exit 1
fi

VERBOSE_FLAG=""
if [ "${VERBOSE:-0}" = "1" ]; then
  VERBOSE_FLAG="-v"
fi

echo "==> Running the T0 kind provisioning E2E (drives RunDeployV2 end to end)"
echo "    cd $CORE_DIR"
echo "    go test -tags=e2e_local ./provisioner/ -run TestE2ELocalKindProvisioning -count=1 -timeout $GOTEST_TIMEOUT"
cd "$CORE_DIR"
go test -tags=e2e_local ./provisioner/ \
  -run TestE2ELocalKindProvisioning \
  -count=1 \
  -timeout "$GOTEST_TIMEOUT" \
  $VERBOSE_FLAG

echo "==> Hermetic provisioning E2E passed (cluster brought up + torn down)."
