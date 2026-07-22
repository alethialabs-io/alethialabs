<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Runner → cluster provisioning — cloud parity & e2e board

Living status for **per-cloud runner health + cluster provisioning**: does each cloud's runner image
(`runner-{aws,gcp,azure,hetzner}`) boot + **register**, and can a runner **provision a real cluster**
(EKS / GKE / AKS / Talos) on that cloud from a connected keyless identity. Tracking epic: **#1050**.
Run history: [`demos/proofs/runner-xcloud-e2e-log.md`](../../demos/proofs/runner-xcloud-e2e-log.md).

**How to update:** every e2e run is recorded by `scripts/e2e/runner-e2e.sh <cloud> <register|cluster>`
(appends the ledger + captures a scrubbed proof bundle + files a deduped issue on failure). Flip the
matrix cell when a stage's verdict changes, and link the run/issue. **Failures are recorded, never hidden.**

Legend: ✅ done/green · ⏳ pending · 🚫 blocked (reason) · — n/a

## Parity matrix (feature × cloud)

| Cloud | image arch ✓ | runner registers | connector wired | **cluster provision (T2)** | signed receipt | security-reviewed | known issues |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---|
| **Hetzner** — Talos | ⏳ (#1052) | ⏳ | ✅ token | ✅ (nightly) | ✅ | ✅ | — |
| **AWS** — EKS (`alethialabs`) | ⏳ (#1052) | ⏳ | ✅ keyless role | ⏳ (wired, gate off) | ✅ | ⏳ | — |
| **GCP** — GKE (`itgix`) | ⏳ (#1052) | ⏳ | ✅ keyless WIF | ⏳ (wired, gate off) | ✅ | ⏳ | — |
| **Azure** — AKS (student sub) | ⏳ (#1052) | ⏳ | ✅ keyless UAMI | ⏳ (wired, gate off) | ✅ | ⏳ | AKS quota TBD |
| Alibaba — ACK | ⏳ (#1052) | ⏳ | ✅ keyless RAM | ⏳ (wired, gate off) | ✅ | ⏳ | — |

- **image arch ✓** = the published `runner-<cloud>:latest` **amd64** image ships a genuine x86-64 runner
  (the INCIDENT regression: an arm64 binary in the amd64 image crash-looped every x86 fleet VM). Turns ✅
  once the arch fix (**#1052**) merges + `deploy-console.yml` rebuilds the images. Run: `runner-e2e.sh <cloud> register`.
- **runner registers** = a fleet VM on that image boots + self-registers (heartbeat, `runners` row). Gated
  on `image arch ✓` + the redeploy.
- **cluster provision (T2)** = the real-apply harness `test/e2e/t2_provision_test.go`
  (`TestT2RealCloudProvisioning`, `-tags=e2e_t2`) → `SUCCESS` job + Ready cluster + signed receipt + ArgoCD
  Healthy/Synced. Wired for **all** clouds in `.github/workflows/e2e-nightly.yml`; **only Hetzner runs
  today** — the others green-skip until each gate secret/var is set (`E2E_AWS_ROLE_ARN` /
  `E2E_GCP_WIF_PROVIDER`+`_SA_EMAIL` / `E2E_AZURE_*`). Run: `runner-e2e.sh <cloud> cluster`.
- **connector wired** = keyless connect scripted in `infra/connector/<cloud>/alethia-<cloud>-setup.sh`
  (AWS role / GCP WIF / Azure UAMI / Alibaba RAM); Hetzner is a scoped API token.

## What's left

- [ ] **Ship #1052** (runner-image cross-compile fix) → train → redeploy correct-arch images. Then flip
      every `image arch ✓` to ✅ (via `runner-e2e.sh <cloud> register`).
- [ ] **Fleet circuit-breaker** (auto-pause a zero-registration reap loop) — #1056.
- [ ] **Stage 1 — registration** on each published image once the redeploy lands.
- [ ] **Stage 2 — cluster provision** per cloud: run the connector CloudShell script, set the gate
      secret/var, dispatch `e2e-nightly.yml provider=<cloud>` (or `runner-e2e.sh <cloud> cluster`).
      Accounts: AWS=`alethialabs`, GCP=`itgix`, Azure=student sub, Hetzner=token. **Real money** — each
      cloud enabled deliberately, cost-guarded (cheapest node shape, single-NAT, AWS cost ceiling).

## Flagged issues
- **INCIDENT 2026-07-22 — fleet runner-churn (root cause).** Multi-arch build shipped an arm64 binary in
  the amd64 image; after #726 flipped the fleet to x86 `cpx31` VMs, every VM crash-looped (`execve`
  ENOEXEC) → never registered → the scaler reaped+recreated every ~4 min for ~8h (~100 emails). Confirmed
  on `runner-azure` **and** `runner-aws` (`e_machine=0xb7`). Mitigated: prod `azure` pool disabled; fixed
  in #1052 + a circuit-breaker in #1056.

## Security findings
- (none yet — populate as the per-cloud e2e runs + reviews land.)

## AI-caught improvements
- The `register` stage (published-image ELF-arch check) is a cheap CI-runnable regression guard that would
  have caught the INCIDENT before it reached prod. Wire it into CI as a follow-up.
