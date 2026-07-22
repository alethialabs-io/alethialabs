<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Runner → cluster provisioning — e2e run history (append-only)

Every `scripts/e2e/runner-e2e.sh <cloud> <register|cluster>` run appends one row here (newest at the
bottom) and writes a scrubbed proof bundle under `demos/proofs/<cloud>/<stamp>/`. This is the durable
audit trail — git history is the timeline. Parity board:
[`docs/testing/runner-xcloud-parity.md`](../../docs/testing/runner-xcloud-parity.md). Tracking: **#1050**.

- **stage**: `register` (published `runner-<cloud>` amd64 image ships a genuine x86-64 runner) ·
  `cluster` (full T2 real-apply → Ready cluster + signed receipt).
- **verdict**: `PASS` · `FAIL` · `BLOCKED` (couldn't run — record why, so we know what's still untested).

| Date (UTC) | git sha | Cloud | Stage | Verdict | Detail | Proof bundle | Issue |
|---|---|---|---|---|---|---|---|
| 2026-07-22 | (pre-#1052) | azure | register | **FAIL** | amd64 image shipped an ARM64 runner (`e_machine=0xb7`) — the INCIDENT bug; diag cpx31 VM crash-looped on ENOEXEC, never registered | manual diag (VM 153847169) | #1050 |
| 2026-07-22 | (pre-#1052) | aws | register | **FAIL** | amd64 image shipped an ARM64 runner (`e_machine=0xb7`) — same build bug | manual diag | #1050 |
<!-- runner-e2e.sh appends new rows below this line -->
