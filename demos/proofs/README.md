<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Provisioning proofs (`demos/proofs/`)

Committable evidence that the provisioning spine works against **real** infrastructure
— the honest "SUCCESS = a working cluster" artifact, not a screenshot. Each proof is a
timestamped directory (`e1-<provider>/<UTC-stamp>/`) holding the cluster's state at the
moment a `DEPLOY` job reached `SUCCESS`: node readiness, pod status, ArgoCD app health,
the CNI/cloud-integration bootstrap, plus a `RUN-NOTES.md` template and (attached by
hand) the deploy log and the ed25519 verify receipt.

## The two tiers

| Tier   | Cluster                | Cost | Where it runs |
| ------ | ---------------------- | ---- | ------------- |
| **T1** | hermetic local `kind`  | $0   | `ci.yml` → `provision-e2e`, merge-queue-gated |
| **T2** | a **real cloud** cluster | ~cents/run | `e2e-nightly.yml`, nightly + manual, **maintainer-gated** |

Both drive the identical spine — the real runner binary claims a real `DEPLOY` job from
a real Postgres-backed control plane and runs `RunDeployV2` (plan → verify gate → signed
receipt → apply → reachability gate → ArgoCD) — asserting the same outcomes
(`cluster_ready` + a signed receipt sealed to the plan hash + shipped logs + a Ready
node). T1 proves the spine for free on kind; **T2 proves it against a genuine cloud**
(`infra/templates/project/<provider>`, Hetzner/Talos first).

## How the nightly captures land

`.github/workflows/e2e-nightly.yml`, on a `SUCCESS`:

1. runs `test/e2e/t2_provision_test.go` (`-tags=e2e_t2`) — the real cluster comes up and
   the runner writes a host-usable kubeconfig to `$HOME/.alethia/kubeconfig`;
2. runs **`./demos/proofs/capture-e1.sh <provider> nightly-<run_id>`** with that
   kubeconfig, writing `demos/proofs/e1-<provider>/<UTC-stamp>/`;
3. uploads that directory as the workflow artifact `e2e-proof-<provider>-<run_id>`
   (30-day retention) — the run does **not** push to the repo (the nightly has read-only
   `contents` and `dev` is protected).

To keep a proof: download the artifact, fill in `RUN-NOTES.md`, attach the DEPLOY job's
`deploy-log.txt` + the `receipt.json` from Evidence, and commit it under
`demos/proofs/e1-<provider>/…` yourself.

## Enabling the T2 nightly (maintainer)

It provisions **real, billable** infrastructure, so it is **off until you opt in**:

1. Add the repo secret **`HCLOUD_TOKEN`** — a scoped Hetzner Cloud API token (Project →
   Security → API Tokens, read/write). That is the only wiring required.
2. That's it. The nightly (03:17 UTC) and manual `workflow_dispatch` will then run for
   real. Until the secret exists, the job **skips cleanly (green) with a loud warning** —
   never a false red, and never a false green (nothing is claimed to be proven).

**Cost:** one tiny Talos cluster — 1 control-plane + 1 worker on the cheapest `cax11`
(ARM) servers — up for ~15–25 min, then destroyed. On the order of a few euro-cents per
run. If your Hetzner project lacks ARM quota (common on brand-new accounts), switch the
template/provider defaults to an `cpx*` (amd64) type; nightly region defaults to `nbg1`
(overridable via the `region` dispatch input).

**Adding a provider (aws/azure):** extend the `matrix.provider` list and the `case` in
the workflow's *Gate on the provider secret* step with that provider's secret. The Go
harness already keys off `ALETHIA_E2E_PROVIDER`; only the credential env + template wiring
differ.

## Teardown is guaranteed — and never account-wide

The Hetzner account is **shared with production**; an unfiltered delete once nearly wiped
prod. Teardown is therefore layered and always **label-scoped to this run's unique
cluster** (`<project>-<env>`, derived from the GitHub run id/attempt):

- **Graceful (in-process):** the T2 test's `t.Cleanup` runs the real `tofu destroy`
  (`provisioner.RunDestroy`), registered **before** the deploy so it runs even on a
  mid-apply failure. The control plane's state backend is in-memory, so it dies with the
  process — there is no persisted state to purge.
- **Guaranteed (belt-and-suspenders):** the workflow's `always()` step runs
  **`scripts/e2e/hcloud-cleanup.sh <cluster>`**, which deletes **only** resources
  carrying the label `cluster=<cluster>` (the exact label the template stamps on every
  server/network/firewall/primary-IP/image). It refuses to run without a specific,
  plausibly-unique cluster name and asserts the selector on every call — so a hard-killed
  test process can never leak, and the cleanup can never touch prod or another run.

Residual note: CSI-provisioned `pvc-*` volumes created *inside* the cluster are labelled
by the CSI driver, not the template, so neither `tofu destroy` nor the label filter
guarantees their removal. The nightly cluster runs no PVC workloads, but periodically
`hcloud volume list` for stray `pvc-*` volumes.

## Running T2 locally (optional)

```bash
export HCLOUD_TOKEN=...                       # a Hetzner API token
export ALETHIA_DATABASE_URL=postgres://...    # a migrated control-plane DB (pnpm db:up)
export ALETHIA_E2E_PROJECT=alethia-nl ALETHIA_E2E_ENV="local-$(date +%s)"
export ALETHIA_E2E_HCLOUD_REGION=nbg1
cd test/e2e && GOWORK=off go test -tags=e2e_t2 ./... -run TestT2RealCloudProvisioning -v
# then tear down the belt-and-suspenders way if the test was killed:
scripts/e2e/hcloud-cleanup.sh "$ALETHIA_E2E_PROJECT-$ALETHIA_E2E_ENV"
```

Without `HCLOUD_TOKEN`/tools it **skips** (a dev laptop is never forced to hold a token);
set `ALETHIA_E2E_T2_REQUIRE=1` to make a missing prerequisite a hard fail, as the nightly
does.
