<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Cross-account keyless container registry — cloud parity & e2e board

Living status for the **cross-account keyless registry** feature (`ecr-xacct` / `gar-xacct` / `acr-xacct`
— pull an image from an ECR/GAR/ACR in a *different* account/project/subscription than the cluster, with
**no stored key**; the pull token is minted in-cluster from a Workload Identity by `alethia registry-token`
and patched into the `<slug>-pull` Secret). Tracking epic: **#1046**. Companion to `#925` (connectors-v2 W-B)
and the run history in [`demos/proofs/xacct-registry-e2e-log.md`](../../demos/proofs/xacct-registry-e2e-log.md).

**How to update:** every e2e run is recorded by `scripts/e2e/registry-e2e.sh` (appends the ledger + captures
a scrubbed proof bundle + files a deduped issue on failure). Flip the matrix cell here when a stage's verdict
changes, and link the run/issue. **Failures are recorded, never hidden.**

Legend: ✅ done/green · ⏳ pending · 🚫 blocked (reason) · — n/a

## Parity matrix (feature × cloud)

| Cloud | Catalog+model (B1) | Refresher mint (B2) | Tofu pull role (B4) | Wiring (B3) | **Real mint e2e** | **In-cluster e2e** | Security-reviewed |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **AWS — ECR** (`ecr-xacct`) | ✅ | ✅ | ✅ | ✅ | ✅ [2026-07-22] | ⏳ | ✅ |
| **GCP — GAR** (`gar-xacct`) | ✅ | ✅ | ✅ | ✅ | ✅ [2026-07-22] | ⏳ | ✅ |
| **Azure — ACR** (`acr-xacct`) | ✅ | ✅ | ✅ | ✅ | ✅ [2026-07-22] (exchange) | ⏳ | ✅ |
| Hetzner / DO / Civo | — | — | — | — | — | — | — |

- **Real mint e2e** = the `registry-token` mint func run against a live registry, token proven to pull an
  image (`crane`), with local ambient creds — no cluster. Vehicle: `apps/runner/internal/agent/registry_token_real_test.go`
  (env-gated `ALETHIA_E2E_ECR_*` / `GAR_*` / `ACR_*`). See the ledger for the exact runs.
- **In-cluster e2e** = the full path: B4 tofu Workload-Identity pull role → the refresher Deployment's KSA
  mints **with no local creds** → patches the Secret → a real app pod pulls the cross-account image. Vehicle:
  the T2 harness (`test/e2e`, `-tags=e2e_t2`, `ALETHIA_E2E_XACCT_REGISTRY=1`).
- **Hetzner/DO/Civo**: explicit parity **exclusion** — token clouds with no cross-account keyless registry
  federation ([[cloud-parity-rule]]). Documented, not a silent gap.

## What's left

- [ ] **In-cluster e2e (all 3 clouds)** — the WI-federation half is unproven (**#1047**). AWS runs in `tovr`
      (`364205735303`, cluster) pulling from `alethia` (`270587882865`, registry). GCP in `itgix-adp`. Azure
      on the "Azure for Students" sub (AKS quota TBD — record the block if denied).
- [ ] **Flip `coming_soon` → `active`** on the 3 catalog rows + enable `ALETHIA_XACCT_REGISTRY_ENABLED` in
      prod — **only after** the in-cluster e2e is green on the target clouds (maintainer action).
- [ ] **GAR full mint e2e** was run in a **client** project (`itgix-adp`) — re-run in an Alethia-owned
      billing project when one exists.
- [ ] **ACR cross-*subscription*** not exercised (single sub available) — the same-sub exchange is proven;
      the literal cross-sub hop needs a second Azure subscription.

## Flagged issues

_(none open — link GH issues here as they're filed)_

## Security findings (from `alethia-security-review`, all fixed before merge)

- **ACR token exfil guard** — `mintACRDockerConfig` sent a broad AAD (`management.azure.com`) token to a host
  from `provider_config`; added a fail-closed `*.azurecr.io` host allowlist so a wrong/tampered host can't
  exfiltrate the token. (B2)
- **Flag-off inertness** — the wiring PR briefly flipped rows to `active`, which would let `compose` set the
  tofu guard while the flag was off (tofu **not** byte-identical). Fixed: rows stay `coming_soon`. (B3)
- **No secret at rest / in logs** — the mint token never touches `argv` (`kubectl patch --patch-file`),
  logs, `config_snapshot`, `execution_metadata`, or the git-committed manifest (empty `{"auths":{}}`
  placeholder). Least-priv RBAC: `get`+`patch` on the one `<slug>-pull` Secret. (B2/B3)

## AI-caught improvements

- **`acrAADScope` was a guess → confirmed** by the real ACR exchange run (`https://management.azure.com/`).
- **`mintACRDockerConfig` is WI-only** (`NewWorkloadIdentityCredential`) so the full func isn't locally
  testable; a small DI refactor (accept a token-getter) would make it testable off-cluster like ECR/GAR.
  Tracked as an enhancement (**#1048**).

## Ops observations

- **Mergify was SKIPPING** (queue not landing CLEAN PRs) — the #1032 `tofu apply` removing the native queue
  rule hadn't run; merged via `gh pr merge <n> --squash` direct in the meantime.
- **`gofmt` is gated by golangci-lint** (not `go test`) — run `gofmt -w` before pushing Go.
