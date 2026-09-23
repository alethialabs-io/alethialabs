# Keyless database auth — run ledger

Append-only. One row per attempted run of the T2 keyless scenario, whatever the outcome. Written by
`scripts/e2e/keyless-db-e2e.sh`; do not hand-edit except to correct a typo in a note.

Parity board: [`docs/testing/keyless-db-parity.md`](../../docs/testing/keyless-db-parity.md).

**A SKIPPED test is recorded BLOCKED, never PASS.** That distinction is the whole point of an
append-only ledger: the provisioning board spent weeks reporting four clouds' green-skips as proofs
(#1723), and the only defence is a record that says what actually ran.

A cell on the parity board goes ✅ **only** when a PASS row here names the run that proved it.

## Run history

**NOT MEASURED — every cell, on every cloud, for both engines.** No run has been attempted. The
table below is empty of rows because nothing has ever been recorded, not because a result is
pending transcription.

| date (UTC) | cloud | engine | result | sha | detail / bundle |
|---|---|---|---|---|---|
<!-- keyless-db-e2e.sh appends new rows below this line -->

## Status of every cell, stated explicitly

An absent row and an empty row read identically to someone scanning for a result, and both read
like "fine so far". Each cell is therefore named here with its own verdict, so that "we have not
looked" is a thing this file SAYS rather than a thing a reader has to infer from a gap.

| cloud | engine | runs attempted | verdict |
|---|---|:--:|---|
| aws | postgres | 0 | **NOT MEASURED** |
| aws | mysql | 0 | **NOT MEASURED** |
| gcp | postgres | 0 | **NOT MEASURED** |
| gcp | mysql | 0 | **NOT MEASURED** |
| azure | postgres | 0 | **NOT MEASURED** |
| azure | mysql | 0 | **NOT MEASURED** |
| alibaba | postgres, mysql | n/a | **EXCLUDED** — RAM governs ApsaraDB's control plane only; no data-plane token login |
| hetzner | postgres | n/a | **EXCLUDED** — in-cluster CloudNativePG; no managed instance, no cloud identity plane |
| hetzner | mysql | n/a | **EXCLUDED** — MySQL is not offered on Hetzner |

The excluded cells are product boundaries and will never produce a row; `keyless-db-e2e.sh` refuses
them rather than recording a failure against a boundary that is working.

## Why the ledger is empty

The harness (#1511) is real and asserts the right things — the `wired` decision record, no password
material anywhere in the pod spec, `DATABASE_HOST = 127.0.0.1`, a sha256-verified query round-trip,
survival past token expiry, and a negative control where an unscoped identity must be denied.

It has never been dispatched: T2 real applies are `main`-gated, and the repo variables the nightly
reads (`vars.E2E_KEYLESS_DB` and friends) have never been set.

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
happens. The recorder reads the verdict from the summary the scenario itself writes, so a run whose
keyless stage never executed records BLOCKED even when the surrounding test exits green.
