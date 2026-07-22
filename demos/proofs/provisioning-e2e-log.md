<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Provisioning e2e — run history (append-only)

Every `scripts/e2e/provisioning-e2e.sh` run — and the nightly `rollup` job — appends one row here (newest
at the bottom) and writes a scrubbed proof bundle under `demos/proofs/<cloud>/<stamp>/`. This is the durable
audit trail; git history is the timeline. Parity board:
[`docs/testing/provisioning-e2e-parity.md`](../../docs/testing/provisioning-e2e-parity.md).

- **dimension**: `floor` (provision + cluster_ready + ArgoCD converge) · `maxconfig` (all 11 kinds) ·
  `addons` (all 19 add-ons Healthy+Synced) · `byo` (A0.6 BYO-IaC + services) · `day2` (day-2 access) ·
  `teardown` (verify_swept to zero) · `full` (every dimension in one apply).
- **verdict**: `PASS` · `FAIL` · `BLOCKED` (couldn't run — record why).
- **bundle**: proof path (or `nightly-<run_id>` for a scheduled run, or `—` for a manual pre-helper note).

| UTC date | git sha | cloud | dimension | verdict | detail | bundle | issue |
|----------|---------|-------|-----------|---------|--------|--------|-------|
| 2026-07-22 | 8c53441 | aws | floor | **FAIL** | apply OK (124 res) but runner 401s on EKS API — access-entry ↔ IAM-path mismatch; teardown destroyed=false | `nightly-29895597616` | #1040 |
| 2026-07-22 | 8c53441 | gcp | floor | **PASS** | nightly green — provision + cluster_ready + ArgoCD converge (cheapest shape) | `nightly-29895597616` | — |
| 2026-07-22 | 8c53441 | azure | floor | **PASS** | nightly green — provision + cluster_ready + ArgoCD converge (cheapest shape) | `nightly-29895597616` | — |
| 2026-07-22 | 8c53441 | alibaba | floor | **PASS** | nightly green (out of the 3-cloud FULLY-TESTED program; tracked for parity) | `nightly-29895597616` | — |
| 2026-07-22 | 8c53441 | hetzner | floor | **PASS** | nightly green (out of the 3-cloud FULLY-TESTED program; tracked for parity) | `nightly-29895597616` | — |

<!-- provisioning-e2e.sh appends new rows below this line -->
