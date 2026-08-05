<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Provisioning e2e — run history (append-only)

Every `scripts/e2e/provisioning-e2e.sh` run — and the nightly `rollup` job — appends one row here (newest
at the bottom) and writes a scrubbed proof bundle under `demos/proofs/<cloud>/<stamp>/`. This is the durable
audit trail; git history is the timeline. Parity board:
[`docs/testing/provisioning-e2e-parity.md`](../../docs/testing/provisioning-e2e-parity.md).

- **dimension**: `floor` (provision + cluster_ready + ArgoCD converge) · `maxconfig` (all 11 kinds) ·
  `addons` (all 19 add-ons Healthy+Synced) · `byo` (A0.6 bring-your-own **Helm chart** + apps repo —
  **not** bring-your-own IaC; no customer OpenTofu runs in it) · `day2` (day-2 access) ·
  `teardown` (verify_swept to zero) · `full` (every dimension in one apply).
- **verdict**: `PASS` · `FAIL` · `BLOCKED` (couldn't run — record why) · `RETRACTED` (an
  append-only correction of a prior record). A `RETRACTED` row must name the superseded row and
  explain the evidence that invalidates it; it never erases the original record.
- **bundle**: proof path (or `nightly-<run_id>` for a scheduled run, or `—` for a manual pre-helper note).

| UTC date | git sha | cloud | dimension | verdict | detail | bundle | issue |
|----------|---------|-------|-----------|---------|--------|--------|-------|
| 2026-07-22 | 8c53441 | aws | floor | **FAIL** | apply OK (124 res) but runner 401s on EKS API — access-entry ↔ IAM-path mismatch; teardown destroyed=false | `nightly-29895597616` | #1040 |
| 2026-07-22 | 8c53441 | gcp | floor | **PASS** | nightly green — provision + cluster_ready + ArgoCD converge (cheapest shape) | `nightly-29895597616` | — |
| 2026-07-22 | 8c53441 | azure | floor | **PASS** | nightly green — provision + cluster_ready + ArgoCD converge (cheapest shape) | `nightly-29895597616` | — |
| 2026-07-22 | 8c53441 | alibaba | floor | **PASS** | nightly green (out of the 3-cloud FULLY-TESTED program; tracked for parity) | `nightly-29895597616` | — |
| 2026-07-22 | 8c53441 | hetzner | floor | **PASS** | nightly green (out of the 3-cloud FULLY-TESTED program; tracked for parity) | `nightly-29895597616` | — |
| 2026-07-31 | 8c53441 | gcp | floor | **RETRACTED** | Supersedes the 2026-07-22 GCP/floor PASS: `nightly-29895597616` recorded an explicit gate-off SKIP (`E2E_GCP_WIF_PROVIDER` unset); no provision or proof bundle ran. | `nightly-29895597616` | #1723 |
| 2026-07-31 | 8c53441 | azure | floor | **RETRACTED** | Supersedes the 2026-07-22 Azure/floor PASS: `nightly-29895597616` recorded an explicit gate-off SKIP; no provision or proof bundle ran. | `nightly-29895597616` | #1723 |
| 2026-07-31 | 8c53441 | alibaba | floor | **RETRACTED** | Supersedes the 2026-07-22 Alibaba/floor PASS: `nightly-29895597616` recorded an explicit gate-off SKIP; no provision or proof bundle ran. | `nightly-29895597616` | #1723 |
| 2026-07-31 | 8c53441 | hetzner | floor | **RETRACTED** | Supersedes the 2026-07-22 Hetzner/floor PASS: `nightly-29895597616` recorded an explicit gate-off SKIP; no provision or proof bundle ran. | `nightly-29895597616` | #1723 |

<!-- provisioning-e2e.sh appends new rows below this line -->
| 2026-08-05 | fa093c24 | hetzner | addons | **FAIL** | ArgoCD gate: 12/20 apps not Healthy+Synced within 8m. Cluster provisioned and reachable (7 nodes Ready, k8s 1.35.6, signed receipt verified); addon-reloader and metrics-server BOTH converged, so #1714 and #1722 are verified. addon-loki cannot render at all (#2058). Teardown swept to zero. | `demos/proofs/hetzner/20260805T064043Z` | #2058 |
