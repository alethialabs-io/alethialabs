# Keyless database auth — run ledger

Append-only. One row per attempted run of the T2 keyless scenario, whatever the outcome. Written by
`scripts/e2e/keyless-db-e2e.sh`; do not hand-edit except to correct a typo in a note.

Parity board: [`docs/testing/keyless-db-parity.md`](../../docs/testing/keyless-db-parity.md).

**A SKIPPED test is recorded BLOCKED, never PASS.** That distinction is the whole point of an
append-only ledger: the provisioning board spent weeks reporting four clouds' green-skips as proofs
(#1723), and the only defence is a record that says what actually ran.

A cell on the parity board goes ✅ **only** when a PASS row here names the run that proved it.

| date (UTC) | cloud | engine | result | sha | detail / bundle |
|---|---|---|---|---|---|
<!-- keyless-db-e2e.sh appends new rows below this line -->
| — | — | — | — | — | _No run yet. The scenario has never been dispatched: T2 real applies are `main`-gated._ |

## Why the ledger is empty

The harness (#1511) is real and asserts the right things — the `wired` decision record, no password
material anywhere in the pod spec, `DATABASE_HOST = 127.0.0.1`, a sha256-verified query round-trip,
survival past token expiry, and a negative control where an unscoped identity must be denied.

It was also, until #1795 landed, **unable to pass on aws or azure**: `ALETHIA_RUNNER_IMAGE` was read
by the sidecar and bootstrap-Job renders and set by nothing that shipped (#1787), so both failed
closed on every deployed runner. The first run should therefore be treated as proving the fix as
much as the feature.

## First runs to schedule

Six live cells, `main`-gated, maintainer-dispatched:

| # | cloud | engine | why this order |
|---|---|---|---|
| 1 | aws | postgres | the reference `db-authproxy` path; proves #1787's fix end-to-end |
| 2 | aws | mysql | same proxy, other engine — pins the 3306/5432 threading |
| 3 | gcp | postgres | the only self-contained mechanism (cloud-sql-proxy), so a failure here is NOT the runner image |
| 4 | gcp | mysql | |
| 5 | azure | postgres | Entra token path |
| 6 | azure | mysql | needs the app-side UAMI from #1464 |

Record each with `scripts/e2e/keyless-db-e2e.sh <cloud> <engine>` so the row lands here whatever
happens.
