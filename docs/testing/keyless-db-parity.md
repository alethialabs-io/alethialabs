# Keyless database auth — parity board

Status of epic [#1500](https://github.com/alethialabs-io/alethialabs/issues/1500) (an IAM-auth
database binding holds **no password**) and the flag deletion that ends it,
[#1513](https://github.com/alethialabs-io/alethialabs/issues/1513).

Legend: ✅ proven on a real apply · 🟡 implemented, not yet proven · ⏳ in progress · 🚫 blocked,
with the reason stated · — documented exclusion

Run history: [`demos/proofs/keyless-db-e2e-log.md`](../../demos/proofs/keyless-db-e2e-log.md). Every
run is recorded by `scripts/e2e/keyless-db-e2e.sh`, including blocked ones. **A cell never goes ✅
from a code change** — only from a recorded real-apply run.

Cell states below are the ones `manifests.KeylessCell` actually returns; the exclusion prose is
quoted from the same table the canvas shows on the disabled toggle, so this board cannot claim
something the product does not say.

## Matrix

| leg | aws · postgres | aws · mysql | gcp · postgres | gcp · mysql | azure · postgres | azure · mysql |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Cell state (`KeylessCell`) | live | live | live | live | live | live |
| Tofu IAM-auth flag reaches the instance | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| App-side identity + outputs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bootstrap SQL (login creation) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bootstrap **Job renders** | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| Runtime proxy in the pod | 🟡 `db-authproxy` | 🟡 `db-authproxy` | 🟡 cloud-sql-proxy | 🟡 cloud-sql-proxy | 🟡 `db-authproxy` | 🟡 `db-authproxy` |
| **Real-apply proof (app authenticates)** | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Security-reviewed | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Documented exclusions

| cell | reason (quoted from the cell table) |
|---|---|
| alibaba · postgres, alibaba · mysql | Unavailable on Alibaba Cloud. RAM governs ApsaraDB's control plane only — there is no data-plane token login for a keyless connection to authenticate with. This database keeps a generated password. |
| hetzner · postgres | Unavailable on Hetzner. Postgres runs in-cluster via CloudNativePG — there is no managed instance and no cloud identity plane to mint database tokens against. This database keeps a generated password. |
| hetzner · mysql | MySQL is not offered on Hetzner — the in-cluster CloudNativePG operator is PostgreSQL only. |

These are product boundaries, not gaps. The canvas disables the toggle there with this exact prose,
the server gate refuses the row, and a deploy that reaches one of them warns rather than failing —
see #1790 for why the severity differs from a live cell.

## Why every live cell is 🟡 and not ✅

**No run has ever happened.** The T2 keyless scenario (#1511) is real and non-vacuous — it asserts
the `wired` decision record, that no password material appears anywhere in the pod spec, that
`DATABASE_HOST` is `127.0.0.1`, a sha256-verified query round-trip, survival past token expiry, and
a negative control where an unscoped identity must be denied. It has simply never been dispatched:
T2 real applies are `main`-gated, and this ledger is empty.

Until #1795 landed, it also **could not** have passed on aws or azure. `ALETHIA_RUNNER_IMAGE` was
read by the sidecar and bootstrap-Job renders and set by nothing that shipped (#1787), so those
renders failed closed on every deployed runner. GCP's sidecar was unaffected — it uses
`cloud-sql-proxy` — but `bootstrap_job.go` guards **ahead of** the provider switch, so GCP recorded
the binding as `wired` while silently skipping the Job that creates the login. That is why the
bootstrap-Job row is 🟡 on all six cells and not just four.

## What #1513 needs before the flag can be deleted

1. **A real-apply proof per live cell**, recorded below. Six cells, `main`-gated, maintainer-run.
2. **The at-risk-row report** — every existing `iam_auth = true` row, classified. Deleting the flag
   turns each of them into a keyless render on the next deploy. See
   `docs/testing/keyless-db-at-risk-rows.sql`.
3. **The severity decision** in #1790 — shipped as live-cell-only, so an excluded-cell row warns
   rather than failing a tenant's deploy.

## How to record a run

```bash
scripts/e2e/keyless-db-e2e.sh <cloud> <engine>
```

Appends to the ledger whatever happens. A SKIPPED test is recorded **BLOCKED, never PASS** — the
mistake that let four clouds' green-skips read as proofs on the provisioning board (#1723).
