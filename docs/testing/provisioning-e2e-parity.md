<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Provisioning e2e — cloud parity & FULLY-TESTED board

Living status for **real runner provisioning** on each cloud, tracked to the maintainer's **FULLY-TESTED
bar** (not the "provisions + ArgoCD converges" floor). The bar, per cloud, on a **real apply**: every
supported resource kind × all 18 marketplace add-ons Healthy+Synced × BYO-IaC × BYO-IaC *with Alethia
services* × a real day-2 access path — provision → verify → **teardown as a closed loop** (never leave a
cluster/VM running). See [[fully-tested-bar]] / `byoc-proof-program`.

Harness: `.github/workflows/e2e-nightly.yml` (T2 tier) → `test/e2e` (`-tags=e2e_t2`,
`TestT2RealCloudProvisioning`). Run history: [`demos/proofs/provisioning-e2e-log.md`](../../demos/proofs/provisioning-e2e-log.md).
Tracking epic: **#1058**.

**How to update:** every run is recorded by `scripts/e2e/provisioning-e2e.sh` (appends the ledger + writes a
scrubbed proof bundle + files a deduped GitHub issue on failure); the nightly `rollup` job also appends the
ledger. Flip a matrix cell here when a dimension's verdict changes, and link the run/issue. A cell goes ✅
**only with a real-apply proof artifact** in the ledger — never on `tofu validate` alone. **Failures are
recorded, never hidden.**

Legend: ✅ green (real-apply proof) · 🟡 floor-only (provisions + converges, full-bar dimension not yet run) ·
⏳ pending · 🚫 blocked (open issue) · — n/a / out of scope. A green-skipped nightly is neither a
proof nor a ledger row; a later `RETRACTED` ledger row corrects any historical claim without rewriting it.

## Parity matrix (cloud × capability)

| Cloud | Provision + cluster_ready | All kinds (11) | 18 add-ons Healthy+Synced | BYO-IaC | BYO-IaC + services | Day-2 access | Teardown clean | Security-reviewed |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **AWS — EKS** | 🚫 [#1714] | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| **GCP — GKE** | 🚫 [#1716] [#1714] [#1722] | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| **Azure — AKS** | 🚫 [#1722] | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| **Hetzner — Talos** | 🚫 [#1714] | ⏳ (7 of 11 — see below) | — | — | — | — | ✅ | — | <!-- floor tracked by the nightly; the KINDS column is fully described in maxconfig.go: 4 tofu + 3 in-cluster (now actually seeded) + 2 ceilings + 2 deferred-debt -->
| **Alibaba — ACK** | ⏳ | ⏳ ⚠️ | — | — | — | — | ⏳ | — | <!-- floor tracked by the nightly; all 11 kinds are CarriedByTofu in maxconfig.go. ⚠️ = a full bar leaves a standing prepaid CR EE instance; see the All-kinds column notes -->

Column vehicles (all on the same `TestT2RealCloudProvisioning`, gated by env):

- **Provision + cluster_ready** — base T2: real apply → `cluster_ready` → ArgoCD Healthy+Synced over the
  *derived* (non-empty) app set. 🟡 = the nightly's cheapest-shape floor is green, but the full-bar
  dimensions below have not been driven on that cloud.
- **All kinds (11)** — `ALETHIA_E2E_MAX_CONFIG=1` → `AssertMaxConfigKindsInState`. Heavy fixture
  `test/e2e/fixtures/cluster_json.heavy.<cloud>.json`, which now exists for **all five** clouds.
  Every (kind × cloud) cell in `test/e2e/maxconfig.go` carries one of three explicit verdicts
  (`MaxConfigCarriage`) — there is no "unmapped" state any more:
  - **`CarriedByTofu`** — the cloud's IaC creates a resource; a real apply must leave it in the
    deploy's tofu state.
  - **`CarriedInCluster`** — genuinely delivered, but not by cloud IaC. Hetzner's database, cache and
    queue are in-cluster charts (CloudNativePG / Valkey / RabbitMQ, `hetzner-services.ts`), so the
    proof is the named ArgoCD Application reaching Healthy+Synced, not a state count.
  - **`CloudCeiling`** — the cloud genuinely does not offer the kind: no cloud service, and no chart
    in this repo backs it either. Hetzner: `topic`, `nosql`. Alibaba has no ceilings: all 11 kinds
    are `CarriedByTofu`.
  - **`DeferredInProduct`** — hidden and rejected today exactly like a ceiling, but for a different
    reason: a chart this repo already ships backs the kind and only the mapping is missing. That is
    **debt**, and the cell must name the chart (`MaxConfigCell.Chart`, checked against the generated
    add-on catalog on every PR). Hetzner: `secrets` (Vault) and `registry` (Harbor) — both install on
    every full-bar run while the kind that would use them is refused.

  A cloud with no column, a cell with no verdict, or a cloud with no offered kind at all is an
  **error**, not a skip. Read back on every PR by `maxconfig_verdicts_pure_test.go`.

  The two exclusions are reported in **separate** lists (`MaxConfigStateProof.Excluded` /
  `.Deferred`), so a run says "2 kinds this cloud cannot do, 2 kinds we have not wired" rather than
  "4 excluded". They were one shared reason string that read "no chart or cloud service backs it" and
  then appended "(Vault is a marketplace add-on…)" — a sentence contradicting its own parenthesis,
  and the mechanism by which two backlog items stopped being counted.

  ⚠️ **An Alibaba full bar buys a standing monthly subscription.** The `registry` cell is correct —
  `alicloud_cr_ee_repo` is the pushable resource — but reaching it forces its parent
  `alicloud_cr_ee_instance`, which `infra/templates/project/alibaba/modules/cr/main.tf` creates with
  `payment_type = "Subscription"`, `period = 1`. It is the **only** subscription resource in the whole
  Alibaba module tree, and a prepaid instance is not released by `tofu destroy` the way a
  pay-as-you-go one is. So every Alibaba full-bar run leaves a **non-cancellable monthly CR EE Basic
  instance** behind and the teardown still reports clean. Do not drive an Alibaba full bar without
  budgeting for that, and sweep the instances by hand afterwards.

  ⚠️ **A Hetzner full bar needs a second credential pair.** `bucket` on Hetzner is real Object
  Storage behind the `aminueza/minio` provider, which authenticates from `HETZNER_S3_ACCESS_KEY` /
  `HETZNER_S3_SECRET_KEY` — not `HCLOUD_TOKEN`, and Hetzner has no API to mint them (a human creates
  them in the console). The hetzner row's credential gate now requires them whenever
  `ALETHIA_E2E_MAX_CONFIG=1`, so a full-bar run without them fails **before any spend** instead of
  provisioning a whole cluster and dying at the bucket. Deliberately a hard prerequisite rather than
  an "unproven bucket" escape: `CarriedByTofu` means a real apply must leave the resource in state,
  so there is no honest verdict under which the run could report success with `bucket` unproven.
- **18 add-ons Healthy+Synced** — `ALETHIA_E2E_ALL_ADDONS=1` → `AssertArgoAppsHealthy` over all 18.
  18, not 19: the count is the catalog SSOT's (`expectedCatalogSize`, `test/e2e/addon_surface.go`,
  mirroring `ADDON_CATALOG.length`), and cert-manager left the marketplace for the platform rail.
  On Hetzner a full bar converges four MORE Applications than that — the synthesized in-cluster data
  services — which is why the number is read from the fixture and never restated as a threshold.
- **BYO-IaC / BYO-IaC + services** — the A0.6 `ALETHIA_E2E_ARGO_*` + `ALETHIA_E2E_GIT_TOKEN` inputs →
  `t2_argo_repos.go` (ArgoCD-with-repos + BYO-Helm + service-binding-against-BYO-outputs; pod-pull +
  managed-resources asserts).
- **Day-2 access** — a real access path (kubeconfig surface / `PROBE_CLUSTER`) beyond the A0.3 soak (soak
  = liveness + drift + PVC; runs today, but the surfaced access path is the FULLY-TESTED gap).
- **Teardown clean** — `provisioner.RunDestroy` + the scope-locked `scripts/e2e/<cloud>-cleanup.sh`
  `verify_swept` to zero. A leak (`destroyed=false` / orphan) is 🚫, never hidden.
- **Security-reviewed** — `alethia-security-review` run over the harness/template changes for that cloud
  (keyless, RLS, sandbox, secret handling).

## What's left

- [ ] **AWS floor (#1714)** — the EKS access-entry defect in closed #1040 is resolved and its real-run
      teardown was clean; the shared `addon-reloader` convergence defect now blocks the floor. A fresh signed
      real-cloud run is required after that fix before this becomes a floor PASS.
- [ ] **GCP floor (#1716, #1714, #1722)** — the node-pool name can overflow, and the add-on gate has two
      independent convergence defects. The observed failed run tore down cleanly, but it is not a floor PASS.
- [ ] **Azure floor (#1722)** — AKS's platform metrics-server collided with ours; the render gate now skips
      it there. The observed failed run tore down cleanly; a real run is still required for floor proof.
- [ ] **Hetzner floor (#1714)** — provisioning and teardown are verified clean, but `addon-reloader` remains
      OutOfSync, so the floor is blocked rather than proven.
- [ ] **Alibaba floor** — pending enablement and its first real run; no floor or teardown verdict exists.
- [ ] **Raise the nightly (or a dispatch/weekly full-bar job) to the FULLY-TESTED dimensions** —
      `MAX_CONFIG` (11 kinds) + `ALL_ADDONS` (19) + A0.6 BYO/services + a real day-2 access assertion — per
      cloud. Because the full surface is heavy + costly, drive it as an **opt-in full-bar dimension**
      (dispatch input / weekly cron) so the cheap nightly stays the green-floor smoke.
- [x] **Heavy fixtures** — all five now ship (`cluster_json.heavy.{aws,gcp,azure,hetzner,alibaba}.json`),
      so a full-bar run no longer hard-errors in the workflow's "Compute cluster shape" step. Each is
      checked on every PR: it must clear its cloud's floor, pin an instance type
      `packages/core/catalog/catalog.json` actually offers, and declare a `node_size` matching that
      instance's catalogued vCPU/memory (the pair used to be self-attested, and `aws` pinned the
      non-catalog `m5.xlarge`).
- [x] **Hetzner's three in-cluster kinds are seeded by the harness** — `database`/`cache`/`queue` are
      `CarriedInCluster` and asserted against the converged ArgoCD Application set, and the DEPLOY
      snapshot now carries the charts that produce those Applications. Previously it did not: the Go
      harness seeded add-ons from `seedAddOns`/`AllCatalogAddOns` alone, which can never hold the
      Hetzner data services (they are synthesized per component, not chosen from a marketplace), so
      those three cells asserted Applications that could not exist and a Hetzner full-bar run was
      **red by construction**. That was recorded as an inherent blocker on the grounds that
      hand-mirroring `hetznerDataServicesToAddOns` into Go is the drift this repo forbids — true, but
      not the only option: the specs are **generated** on the same rail `addon_catalog.json` already
      uses.

      | | |
      |---|---|
      | SSOT | `apps/console/lib/cloud-providers/hetzner-services.ts` |
      | generator | `pnpm -F console export:hetzner-data-services` |
      | fixture | `test/e2e/fixtures/hetzner_data_services.json` |
      | drift guard (TS) | `tests/lib/cloud-providers/hetzner-data-services-export.test.ts` |
      | read-back (Go) | `TestHetznerDataServiceFixtureMatchesTheMaxConfigSurface`, `TestHetznerInClusterCellsAreCoveredBySeededSpecs` |

      The fixture carries the **components** it was generated from as well as the specs, so the Go
      read-back compares them with the real `MaxConfigProjectConfig("hetzner")` instead of trusting
      that two lists were kept in step by hand. The seed is per-cloud: the other four clouds' add-on
      set is untouched (asserted).
- [ ] **Azure full-bar feasibility** — the e2e subscription has a **10 vCPU** Total Regional quota and
      AKS renders a single pool, so the old `Standard_D4s_v5` ×3 fixture (12 vCPU) could never create.
      The fixture is now `Standard_E2s_v5` ×3 (6 vCPU / 48 GiB) and the total-vCPU floor is per-cloud
      (`heavyMinVCPUByCloud`). ⚠️ The `ESv5 Family vCPUs` quota is separate from Total Regional and can
      be 0; if it is, Azure has no feasible full-bar shape and must become an explicit documented
      exclusion rather than a quietly failing leg.
- [ ] **Day-2 access surface** — the maintainer flagged the missing kubeconfig / ArgoCD-URL surface as the
      gap that motivated the bar (opening `:6443` returned a client-cert 401 — by design, but no access
      path is surfaced). Build + assert it.
- [ ] **Per-cloud `alethia-security-review`** before each dimension flips ✅.

## Flagged issues

| Issue | Cloud | Dimension | Status |
|-------|-------|-----------|--------|
| **#1714** | GCP · Hetzner | Provision + cluster_ready | OPEN — add-on Deployment default drift prevents ArgoCD convergence |
| **#1716** | GCP | Provision + cluster_ready | OPEN — GKE node-pool name can exceed the provider limit |
| **#1722** | GCP · Azure · Alibaba | Provision + cluster_ready | FIXED — the platform metrics-server collided with ours on all three (ACK was the unlogged third); `metrics-server.yaml` now renders on AWS/Hetzner only. Needs a real run per cloud to become a floor PASS |

## Security findings

_(none yet — `alethia-security-review` findings land here as dimensions are driven)_

## AI-caught improvements

- **CLI `--no-input` destroy is a no-op** (`apps/cli/cmd/helpers.go:30` `confirm()` ignores `noInputMode`;
  on a non-TTY it prints "Cancelled" and never queues DESTROY). Hands-on teardown must go via the cloud
  sweepers or the API/server action, not the CLI destroy — otherwise a "torn-down" run silently leaks.
- **AWS EKS pathed-role 401 is a real product gap, not e2e-only** — any customer whose provisioning role
  carries an IAM path hits the same post-apply `Unauthorized`. The fix belongs in the template, benefiting
  all pathed roles ([[cloud-parity-rule]]: EKS-specific by nature — GCP/Azure authorize via IAM roles / AAD
  groups and don't path-strip; documented specificity, not a silent gap).
