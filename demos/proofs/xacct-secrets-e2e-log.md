# Cross-account keyless secret-manager e2e — run ledger

Append-only. Every run of `scripts/e2e/secrets-e2e.sh` adds a row, whatever the verdict — a
**BLOCKED** lane is recorded with its reason rather than skipped silently, so the board can never
look more covered than it is. Feature/cloud status lives in
[`docs/testing/xacct-secrets-parity.md`](../../docs/testing/xacct-secrets-parity.md); this file is
the history.

Verdicts: **PASS** (the value crossed the account boundary and matched) · **FAIL** (it did not — a
GitHub issue is filed automatically) · **BLOCKED** (the run could not proceed; the reason says why).

The proof bundles under `demos/proofs/<cloud>/<stamp>/` are scrubbed. The canary value never appears
in one: the test compares SHA-256, so only the digest ever leaves account B.

| UTC date | git sha | cloud | stage | verdict | detail | bundle | issue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-07-26 | — | gcp | cluster | **BLOCKED** | per-run external-secrets GSA cannot carry a pre-applied cross-project grant; unblocked by adopting a standing GSA | — | #1268 |
| 2026-07-26 | — | azure | cluster | **BLOCKED** | role assignment binds the identity's object id (regenerated per create); also needs a second subscription in the same tenant | — | #1268 |
| 2026-07-26 | — | alibaba | cluster | **BLOCKED** | RRSA needs a RAM OIDC provider registered against this cluster's ACK issuer — inherently per-cluster (honest exclusion) | — | #1268 |
<!-- secrets-e2e.sh appends new rows below this line -->
