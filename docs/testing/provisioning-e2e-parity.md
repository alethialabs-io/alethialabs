<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Provisioning e2e — cloud parity & FULLY-TESTED board

Living status for **real runner provisioning** on each cloud, tracked to the maintainer's **FULLY-TESTED
bar** (not the "provisions + ArgoCD converges" floor). The bar, per cloud, on a **real apply**: every
supported resource kind × all 19 marketplace add-ons Healthy+Synced × BYO-IaC × BYO-IaC *with Alethia
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
⏳ pending · 🚫 blocked (open issue) · — n/a / out of scope

## Parity matrix (cloud × capability)

| Cloud | Provision + cluster_ready | All kinds (11) | 19 add-ons Healthy+Synced | BYO-IaC | BYO-IaC + services | Day-2 access | Teardown clean | Security-reviewed |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **AWS — EKS** | 🚫 [#1040] | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | 🚫 [#1040] | ⏳ |
| **GCP — GKE** | 🟡 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| **Azure — AKS** | 🟡 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ✅ | ⏳ |
| Hetzner · Alibaba | 🟡 | — | — | — | — | — | ✅ | — | <!-- tracked by the nightly; outside this 3-cloud FULLY-TESTED program -->

Column vehicles (all on the same `TestT2RealCloudProvisioning`, gated by env):

- **Provision + cluster_ready** — base T2: real apply → `cluster_ready` → ArgoCD Healthy+Synced over the
  *derived* (non-empty) app set. 🟡 = the nightly's cheapest-shape floor is green, but the full-bar
  dimensions below have not been driven on that cloud.
- **All kinds (11)** — `ALETHIA_E2E_MAX_CONFIG=1` → `AssertMaxConfigKindsInState` (all 11 kinds land in
  tofu state). Heavy fixture `test/e2e/fixtures/cluster_json.heavy.<cloud>.json`.
- **19 add-ons Healthy+Synced** — `ALETHIA_E2E_ALL_ADDONS=1` → `AssertArgoAppsHealthy` over all 19.
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

- [ ] **AWS provision + teardown (#1040)** — real EKS apply succeeds (124 resources) but the runner **401s**
      on the API server (EKS Access-Entry ↔ IAM-path mismatch; the pathed `alethia-e2e-nightly` role's
      session isn't authorized), and the failure path leaves teardown `destroyed=false` → orphan
      VPC/SG/NAT accumulation. **Blocks the entire AWS column.** Fix in progress (module-level access entry).
- [ ] **Raise the nightly (or a dispatch/weekly full-bar job) to the FULLY-TESTED dimensions** —
      `MAX_CONFIG` (11 kinds) + `ALL_ADDONS` (19) + A0.6 BYO/services + a real day-2 access assertion — per
      cloud. Because the full surface is heavy + costly, drive it as an **opt-in full-bar dimension**
      (dispatch input / weekly cron) so the cheap nightly stays the green-floor smoke.
- [ ] **Heavy fixtures** — confirm `cluster_json.heavy.{gcp,azure}.json` exist (only `aws` may be present);
      add the missing ones.
- [ ] **Day-2 access surface** — the maintainer flagged the missing kubeconfig / ArgoCD-URL surface as the
      gap that motivated the bar (opening `:6443` returned a client-cert 401 — by design, but no access
      path is surfaced). Build + assert it.
- [ ] **Per-cloud `alethia-security-review`** before each dimension flips ✅.

## Flagged issues

| Issue | Cloud | Dimension | Status |
|-------|-------|-----------|--------|
| **#1040** | AWS | Provision + teardown | OPEN — EKS access-entry 401 + teardown leak (root-caused) |

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
