<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Cross-account keyless registry — e2e run history (append-only)

Every `scripts/e2e/registry-e2e.sh` run appends one row here (newest at the bottom) and writes a scrubbed
proof bundle under `demos/proofs/<cloud>/<stamp>/`. This is the durable audit trail — git history is the
timeline. See the parity board: [`docs/testing/xacct-registry-parity.md`](../../docs/testing/xacct-registry-parity.md).

- **stage**: `mint` (token minted from a live registry + proven to pull, no cluster) · `cluster` (full
  in-cluster WI → refresher → patch → pod pull, T2).
- **verdict**: `PASS` · `FAIL` · `BLOCKED` (couldn't run — record why, so we know what to test).
- **bundle**: proof path (or `—` for the pre-helper manual runs below).

| UTC date | git sha | cloud | stage | verdict | detail | bundle | issue |
|----------|---------|-------|-------|---------|--------|--------|-------|
| 2026-07-22 | 8ae396dc | aws (ecr-xacct) | mint | **PASS** | `sts:AssumeRole` alethia(270587882865)→tovr(364205735303) role, `GetAuthorizationToken`, `crane` pulled the image | manual (pre-helper) | — |
| 2026-07-22 | 8ae396dc | gcp (gar-xacct) | mint | **PASS** | ADC OAuth token, cross-project GAR (`itgix-adp`), `crane` pulled | manual (pre-helper) | — |
| 2026-07-22 | 8ae396dc | azure (acr-xacct) | mint | **PASS** | AAD (`management.azure.com`) → `/oauth2/exchange` → refresh token, `crane` pulled — **confirms `acrAADScope`** | manual (pre-helper) | — |

<!-- registry-e2e.sh appends new rows below this line -->
