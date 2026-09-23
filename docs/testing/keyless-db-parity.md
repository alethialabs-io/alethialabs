# Keyless database auth — parity board

Status of epic [#1500](https://github.com/alethialabs-io/alethialabs/issues/1500) (an IAM-auth
database binding holds **no password**) and the flag deletion that ends it,
[#1513](https://github.com/alethialabs-io/alethialabs/issues/1513).

Legend:

| | meaning |
|---|---|
| ✅ | **proven on a real apply** — a PASS row in the ledger names the run that proved it |
| 🧪 | **implemented, and covered by unit or golden tests only** — code, not evidence about a live cloud |
| ❔ | **NOT MEASURED** — nothing has ever observed this, on any cloud |
| 🚫 | blocked, with the reason stated |
| — | documented exclusion |

Run history: [`demos/proofs/keyless-db-e2e-log.md`](../../demos/proofs/keyless-db-e2e-log.md). Every
run is recorded by `scripts/e2e/keyless-db-e2e.sh`, including blocked ones. **A cell never goes ✅
from a code change** — only from a recorded real-apply run.

**There is no ✅ anywhere on this board, and that is the finding, not an omission.** The ledger has
zero rows, so by the rule above nothing here can be ✅ yet. An earlier revision marked four rows ✅
across all six cells — 24 cells that no run had ever touched — while its own prose said "no run has
ever happened". The 🧪/❔ split exists so that "we wrote it and the unit tests pass" can never again
be recorded in the same symbol as "we watched it work".

Cell states below are the ones `manifests.KeylessCell` actually returns; the exclusion prose is
quoted from the same table the canvas shows on the disabled toggle, so this board cannot claim
something the product does not say.

## Matrix

| leg | aws · postgres | aws · mysql | gcp · postgres | gcp · mysql | azure · postgres | azure · mysql |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Cell state (`KeylessCell`) | live | live | live | live | live | live |
| Tofu template **sets** the IAM-auth flag | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| The flag is **observed on the instance** | ❔ | ❔ | ❔ | ❔ | ❔ | ❔ |
| App-side identity + outputs | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Bootstrap SQL (login creation) | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Bootstrap **Job renders** | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Bootstrap Job **has ever run** | ❔ | ❔ | ❔ | ❔ | ❔ | ❔ |
| Runtime proxy in the pod | 🧪 `db-authproxy` | 🧪 `db-authproxy` | 🧪 cloud-sql-proxy | 🧪 cloud-sql-proxy | 🧪 `db-authproxy` | 🧪 `db-authproxy` |
| **Real-apply proof (app authenticates)** | ❔ | ❔ | ❔ | ❔ | ❔ | ❔ |
| Keyless-surface static gate (`as any` · `AKIA…` · PEMs) | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 |
| Security **review** of the keyless DB surface | ❔ | ❔ | ❔ | ❔ | ❔ | ❔ |

### What backs each 🧪

Stated so that a reader deciding whether to widen something can check the claim rather than trust
the symbol.

| leg | what actually exists |
|---|---|
| Tofu sets the flag | `infra/templates/project/aws/modules/rds/rds.tf:44` (one path serves both engines, via `rds_config.engine`) · `infra/templates/project/gcp/modules/cloud-sql/main.tf:30-35` (separate postgres/mysql spellings) · `infra/templates/project/azure/modules/azure-db/main.tf:83-89`, `:207-213` + `infra/templates/project/azure/app-db-identity.tf:104-127`. Plan-time coverage is **uneven**, and all of it asserts the module against itself: gcp has a `check` (`mysql_iam_auth_flag_present`) and `gcp/checks_cloud_sql_identity.tftest.hcl`; azure's `azure/checks_cluster.tftest.hcl` asserts the AAD administrator under `azure_db_iam_auth = true`; the aws `.tftest.hcl` files that name the variable set `rds_iam_auth_enabled = false`, so **nothing asserts the aws flag ON** — that 🧪 rests on the template line alone. |
| App-side identity + outputs | `packages/core/manifests/keyless_{aws,gcp,azure}.go:18-41`, each failing closed on a missing template output. Covered by `packages/core/manifests/keyless_test.go`. |
| Bootstrap SQL | all six dialects in `apps/runner/internal/agent/db_bootstrap.go:116-204`, covered per cloud × engine by `db_bootstrap_test.go`. |
| Bootstrap Job renders | `packages/core/manifests/bootstrap_job.go`, covered by `bootstrap_job_test.go`. |
| Static gate | `scripts/security/capabilities-gate.mjs` — a required check that reads the keyless files. See the caveat below. |

### The security row is two different claims

The static gate is real and required (`.github/workflows/capabilities-security.yml`), and it does
reach the keyless sources. But it decides **four deterministic invariants** (its header, A–D): RLS
registration of a new `cloud_capability_*` table, a `provider` filter on queries against one, no
`as any` / `as unknown as`, and no static credentials (`AKIA…` access-key ids, embedded PEMs). Only
the last two bear on the keyless DB code, and its own header disclaims more. It never reads the
bootstrap SQL's privilege grants, the admin-versus-app least-privilege split, or the proxy's token
handling.

So a green gate is not a security review, and **no security review of this surface is recorded
anywhere in the repo** — no findings section here, no report, no issue. Compare
[`xacct-registry-parity.md`](xacct-registry-parity.md), which carries its four findings and their
fixes. Gate G of #1500 asks for the review; until it happens that row stays ❔.

### Documented exclusions

| cell | reason (quoted from the cell table) |
|---|---|
| alibaba · postgres, alibaba · mysql | Unavailable on Alibaba Cloud. RAM governs ApsaraDB's control plane only — there is no data-plane token login for a keyless connection to authenticate with. This database keeps a generated password. |
| hetzner · postgres | Unavailable on Hetzner. Postgres runs in-cluster via CloudNativePG — there is no managed instance and no cloud identity plane to mint database tokens against. This database keeps a generated password. |
| hetzner · mysql | MySQL is not offered on Hetzner — the in-cluster CloudNativePG operator is PostgreSQL only. |

These are product boundaries, not gaps. The canvas disables the toggle there with this exact prose,
the server gate refuses the row, and a deploy that reaches one of them warns rather than failing —
see #1790 for why the severity differs from a live cell.

## Why nothing is ✅

**No run has ever happened.** The T2 keyless scenario (#1511) is real and non-vacuous — it asserts
the `wired` decision record, that no password material appears anywhere in the pod spec, that
`DATABASE_HOST` is `127.0.0.1`, a sha256-verified query round-trip, survival past token expiry, and
a negative control where an unscoped identity must be denied. It has simply never been dispatched:
T2 real applies are `main`-gated, its repo variables have never been set, and this ledger is empty.

Until #1795 landed, it also **could not** have passed on aws or azure. `ALETHIA_RUNNER_IMAGE` was
read by the sidecar and bootstrap-Job renders and set by nothing that shipped (#1787), so those
renders failed closed on every deployed runner. GCP's sidecar was unaffected — it uses
`cloud-sql-proxy` — but `bootstrap_job.go` guards **ahead of** the provider switch, so GCP recorded
the binding as `wired` while silently skipping the Job that creates the login. That is why the
"has ever run" row is ❔ on all six cells and not just four, and it is also why the bootstrap SQL's
dialects, though unit-tested, have never been executed against any database.

#1795 removed that seam: `packages/core/selfimage` resolves the ref, and the runner Dockerfiles bake
`ALETHIA_RUNNER_SELF_IMAGE`, so the variable is now an override rather than a prerequisite. The
first run should therefore be treated as proving that fix as much as the feature.

## What #1513 needs before the flag can be deleted

1. **A real-apply proof per live cell**, recorded in the ledger. Six cells, `main`-gated,
   maintainer-run.
2. **The at-risk-row report** — every existing `iam_auth = true` row, classified. Deleting the flag
   turns each of them into a keyless render on the next deploy. See
   [`keyless-db-at-risk-rows.sql`](keyless-db-at-risk-rows.sql), which reports the rows it cannot
   classify instead of dropping them.
3. **The severity decision** in #1790 — shipped as live-cell-only, so an excluded-cell row warns
   rather than failing a tenant's deploy.
4. **A security review** of the surface, per gate G, with its findings recorded above.

## How to record a run

```bash
scripts/e2e/keyless-db-e2e.sh <cloud> <engine>
```

Appends to the ledger whatever happens. A SKIPPED test is recorded **BLOCKED, never PASS** — the
mistake that let four clouds' green-skips read as proofs on the provisioning board (#1723). The
recorder classifies on the summary the scenario itself writes, not on `go test`'s exit line, and
`scripts/e2e/keyless-db-e2e.sh --self-test` pins that distinction offline.
