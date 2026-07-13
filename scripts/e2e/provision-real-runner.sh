#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# T1 — the REAL-RUNNER hermetic provisioning keystone.
#
# Extends the in-process T0 (scripts/e2e/provision-hermetic.sh): here a separate
# runner PROCESS (the real `apps/runner` binary) claims a QUEUED job from a real,
# Postgres-backed control plane over HTTP, runs the FULL RunDeployV2 spine against a
# genuine local `kind` cluster, and reports back — so the claim / auth /
# status-callback / log-shipping paths are exercised on top of the cluster spine.
#
# A green run proves: the runner claimed → RunDeployV2 → kind came up →
# cluster_ready + a signed verify receipt (sealed to the plan hash) landed in the DB
# via a real status callback → logs shipped to job_logs → an INDEPENDENT
# `kubectl get nodes` (via `kind get kubeconfig`) reports a Ready node → every
# expected ArgoCD Application (derived from the persisted infra_services +
# addon_status metadata; a tiny add-on is seeded so the set is never empty)
# reached Healthy+Synced. Teardown (RunDestroy + docker rm fallback) is guaranteed.
#
# This is the seam the merge-queue CI job (ci.yml → provision-e2e) invokes.
#
# Prereqs (the Go test SKIPS cleanly if a prereq is missing UNLESS
# ALETHIA_E2E_T1_REQUIRE=1, which turns a missing prereq into a hard FAIL — that is
# what CI sets):
#   - docker daemon running (kind needs it)
#   - tofu, kubectl, helm, kind, go on PATH
#   - a MIGRATED Postgres reachable at ALETHIA_DATABASE_URL (default: the dev stack
#     on localhost:5433 — bring it up with `pnpm db:up`)
#
# Usage:
#   scripts/e2e/provision-real-runner.sh
#   ALETHIA_DATABASE_URL=postgres://... scripts/e2e/provision-real-runner.sh
#   VERBOSE=1 scripts/e2e/provision-real-runner.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$REPO_ROOT/test/e2e"
# 30m: the test's own ctx is 20m (deploy wait 8m + ArgoCD convergence assertion 8m
# + build/boot headroom) plus teardown margin.
GOTEST_TIMEOUT="${GOTEST_TIMEOUT:-30m}"
export ALETHIA_DATABASE_URL="${ALETHIA_DATABASE_URL:-postgres://alethia:alethia-dev-secret@localhost:5433/alethia}"
export ALETHIA_E2E_T1_REQUIRE="${ALETHIA_E2E_T1_REQUIRE:-1}"

echo "==> Preflight"
missing=0
for bin in docker tofu kubectl helm kind go; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "    ✓ $bin"
  else
    echo "    ✗ $bin (missing — install it; e.g. 'go install sigs.k8s.io/kind@latest')"
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
  echo "==> One or more prerequisites are missing. Aborting." >&2
  exit 1
fi

VERBOSE_FLAG=""
if [ "${VERBOSE:-0}" = "1" ]; then
  VERBOSE_FLAG="-v"
fi

echo "==> Running the T1 real-runner provisioning E2E (drives the real runner binary)"
echo "    DB: $ALETHIA_DATABASE_URL"
echo "    cd $E2E_DIR"
echo "    GOWORK=off go test -tags=e2e_t1 ./... -run TestT1RealRunnerKindProvisioning -count=1 -timeout $GOTEST_TIMEOUT"
cd "$E2E_DIR"
GOWORK=off go test -tags=e2e_t1 ./... \
  -run TestT1RealRunnerKindProvisioning \
  -count=1 \
  -timeout "$GOTEST_TIMEOUT" \
  $VERBOSE_FLAG

echo "==> T1 real-runner provisioning E2E passed (runner → kind → receipt → kubectl → teardown)."
