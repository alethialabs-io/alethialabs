<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Runner → cluster provisioning — cloud parity & e2e board

Living status for **per-cloud runner health + cluster provisioning**: does each cloud's runner image
(`runner-{aws,gcp,azure,alibaba,hetzner}`) boot + **register**, and can a runner **provision a real cluster**
(EKS / GKE / AKS / Talos) on that cloud from a connected keyless identity. Tracking epic: **#1050**.
Run history: [`demos/proofs/runner-xcloud-e2e-log.md`](../../demos/proofs/runner-xcloud-e2e-log.md).

**How to update:** every e2e run is recorded by `scripts/e2e/runner-e2e.sh <cloud> <register|cluster>`
(appends the ledger + captures a scrubbed proof bundle + files a deduped issue on failure). Flip the
matrix cell when a stage's verdict changes, and link the run/issue. **Failures are recorded, never hidden.**

Legend: ✅ done/green · ⏳ pending · 🚫 blocked (reason) · — n/a

## Parity matrix (feature × cloud)

| Cloud | image arch ✓ | runner registers | connector wired | **cluster provision (T2)** | signed receipt | security-reviewed | known issues |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---|
| **Hetzner** — Talos | ✅ (register) | ⏳ | ✅ token | ✅ (nightly) | ✅ | ✅ | — |
| **AWS** — EKS (`alethialabs`) | ✅ (register) | ⏳ | ✅ keyless role | ⏳ (wired, gate off) | ✅ | ⏳ | — |
| **GCP** — GKE (`itgix`) | ✅ (register) | ⏳ | ✅ keyless WIF | ⏳ (wired, gate off) | ✅ | ⏳ | — |
| **Azure** — AKS (student sub) | ✅ (register) | ✅ (prod) | ✅ keyless UAMI | ⏳ (wired, gate off) | ✅ | ⏳ | AKS quota TBD |
| Alibaba — ACK | ✅ (register) | ⏳ | ✅ keyless RAM | ⏳ (wired, gate off) | ✅ | ⏳ | — |

- **image arch ✓** = the published `runner-<cloud>:latest` **amd64** image ships a genuine x86-64 runner
  (the INCIDENT regression: an arm64 binary in the amd64 image crash-looped every x86 fleet VM). ✅ for
  all five as of **2026-07-22** — `runner-e2e.sh <cloud> register` PASSed on each post-#1052 image
  (`e_machine=0x3e`); see the ledger. A pre-merge CI guard (`runner-image-arch` in `ci.yml`) now asserts
  the same on a freshly-built `runner-base`, so a regression can't reach prod again. Re-run: `runner-e2e.sh <cloud> register`.
- **runner registers** = a fleet VM on that image boots + self-registers (heartbeat, `runners` row).
  ✅ **azure** — a fleet VM registered live on the corrected image during the 2026-07-22 incident
  recovery. The others stay ⏳: the `register` stage proves the image *arch*, not a live self-register
  (that needs a booted VM — mild spend, folded into Stage 2). Gated on `image arch ✓`.
- **cluster provision (T2)** = the real-apply harness `test/e2e/t2_provision_test.go`
  (`TestT2RealCloudProvisioning`, `-tags=e2e_t2`) → `SUCCESS` job + Ready cluster + signed receipt + ArgoCD
  Healthy/Synced. Wired for **all** clouds in `.github/workflows/e2e-nightly.yml`; **only Hetzner runs
  today** — the others green-skip until each gate secret/var is set (`E2E_AWS_ROLE_ARN` /
  `E2E_GCP_WIF_PROVIDER`+`_SA_EMAIL` / `E2E_AZURE_*`). Run: `runner-e2e.sh <cloud> cluster`.
- **connector wired** = keyless connect scripted in `infra/connector/<cloud>/alethia-<cloud>-setup.sh`
  (AWS role / GCP WIF / Azure UAMI / Alibaba RAM); Hetzner is a scoped API token.

## What's left

- [x] **Ship #1052** (runner-image cross-compile fix) → train → redeploy correct-arch images.
- [x] **Fleet circuit-breaker** (auto-pause a zero-registration reap loop) — #1056.
- [x] **Stage 1 — registration** (image-arch proof) on each published image — all five PASS
      (2026-07-22, `runner-e2e.sh <cloud> register`).
- [x] **CI regression guard** — `runner-image-arch` job in `ci.yml` builds `runner-base` for
      `linux/amd64` and fails the PR if `/usr/local/bin/runner` isn't x86-64 (the AI-caught improvement).
- [ ] **Stage 2 — cluster provision** per cloud: run the connector CloudShell script, set the gate
      secret/var, dispatch `e2e-nightly.yml provider=<cloud>` (or `runner-e2e.sh <cloud> cluster`).
      **All clouds**, each enabled **deliberately** + cost-guarded (cheapest node shape, single-NAT, AWS
      cost ceiling), one at a time. Confirmed accounts + gate vars:
  - **AWS** — `alethialabs` *or* tovr's AWS (either works) → `E2E_AWS_ROLE_ARN`
  - **GCP** — `itgix-adp` project → `E2E_GCP_WIF_PROVIDER` + `E2E_GCP_SA_EMAIL`
  - **Azure** — student subscription → `E2E_AZURE_CLIENT_ID` (AKS quota TBD)
  - **Hetzner** — scoped API token → `HCLOUD_TOKEN`

## Flagged issues
- **INCIDENT 2026-07-22 — fleet runner-churn (root cause).** Multi-arch build shipped an arm64 binary in
  the amd64 image; after #726 flipped the fleet to x86 `cpx31` VMs, every VM crash-looped (`execve`
  ENOEXEC) → never registered → the scaler reaped+recreated every ~4 min for ~8h (~100 emails). Confirmed
  on `runner-azure` **and** `runner-aws` (`e_machine=0xb7`). Mitigated: prod `azure` pool disabled; fixed
  in #1052 + a circuit-breaker in #1056.

## Security findings
- (none yet — populate as the per-cloud e2e runs + reviews land.)

## AI-caught improvements
- ✅ **DONE** — the `register` ELF-arch check is now a pre-merge CI guard: `runner-image-arch` in
  `.github/workflows/ci.yml` builds `runner-base` for `linux/amd64` and asserts `/usr/local/bin/runner`
  is x86-64 (`e_machine=0x3e`), failing the PR on `0xb7` (aarch64) — the exact 2026-07-22 regression.
  It builds the real image (a plain `go build` can't reproduce a Dockerfile ARG regression) and covers
  every per-cloud image, which all inherit the binary `FROM runner-base`. Gated on the runner surface
  (`apps/runner/`, `apps/cli/`, `packages/core/`, `go.work`).
