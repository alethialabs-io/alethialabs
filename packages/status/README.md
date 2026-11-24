<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# @repo/status — status.alethialabs.io

The public status page. A Cloudflare Worker: a cron trigger probes seven components every minute, D1
keeps the history, and one KV key holds the rendered page and the JSON. Ported from TOVR's status page
and re-skinned to the Alethia system (grayscale, dark-first, Geist / Geist Mono / Space Grotesk, the
`[·]` mark). English only.

**It runs at Cloudflare's edge, not on our box, and that is the whole point.** A status page inside
the failure domain it reports on is silent in exactly the incident it exists for. A total outage of the
control-plane box is the case this page _reports_, not the case that takes it down too.

## What it measures

`src/probes.ts` is the single source of truth: five endpoints, seven components.

| Component     | Endpoint                         | How failure is detected                                             |
| ------------- | -------------------------------- | ------------------------------------------------------------------- |
| Console       | `alethialabs.io/api/health`      | body `status`: `healthy` up · `degraded` degraded · `unhealthy` down |
| Database      | `alethialabs.io/api/health`      | body `checks.db` or `checks.schema` not `true`                      |
| Authorization | `alethialabs.io/api/health`      | body `checks.openfga` (or, without OpenFGA, the database's verdict) |
| Website       | `alethialabs.io/`                | not 2xx                                                             |
| Docs          | `alethialabs.io/docs`            | not 2xx                                                             |
| News          | `alethialabs.io/news`            | not 2xx                                                             |
| Installer     | `get.alethialabs.io`             | not 2xx, or a body that is not the install script (shebang + markers) |

Console, Database and Authorization are **critical**: one of them down is a major outage. Any other row
down is "some systems degraded".

### The traps, if you change anything here

- **The status code is not the answer.** The console's readiness route answers **200 for `degraded`**
  (a stuck background loop must not drain the load balancer), so the Console row reads the body. And a
  database that is reachable but empty passes `SELECT 1` — TOVR's page documented an outage where its
  health endpoint said "ok" for two days against a schema-less cluster. So `checks.schema` (does the
  `organization` table exist) is asserted separately from `checks.db`.
- **The detail needs a credential.** Anonymous callers of `/api/health` get only `{status, mode, ts}`.
  The three booleans come back only to `Authorization: Bearer <ALETHIA_STATUS_PROBE_TOKEN>` — a
  separate secret from the cron secret, because it lives outside our infrastructure, and it unlocks
  nothing but the booleans. The Worker holds it as the secret binding `STATUS_PROBE_TOKEN`. Without it
  the Database and Authorization rows read **degraded**, with a reason that says the credential was not
  accepted — "I could not tell" is never shown as "it is fine".
- **Redirects are never followed.** On 2026-11-21 `alethialabs.io/news` answered `307 → /login` (the
  route was not deployed yet). Following it would land on the sign-in page, read 200, and report News
  operational. A redirect is reported as down, with its target in the reason, so News reads down until
  `/news` (#7143) is deployed to production — correctly.
- **The contract is tested from both sides.** `apps/console/tests/api/health/status-page-monitors.test.ts`
  runs the real console route through this package's real assertions for every platform state.

### Why there is no Email row

The issue asked for SES ("account sending status not HEALTHY / sending paused"). Reading it means
calling the SES v2 `GetAccount` API, which needs AWS SigV4 credentials. A Worker has no AWS workload
identity to federate from, so the only way to give it one is a **long-lived IAM access key** stored as
a Worker secret — exactly the kind of standing credential the platform is built to avoid. So the row is
omitted. The keyless way to add it later is for the console (which already holds SES credentials in
hosted mode) to read the sending status and add an `email` boolean to the status-probe view.

## Free-tier ceilings the design is shaped by

| Limit                      | Value         | How this stays under it                                                                                     |
| -------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| KV writes                  | 1000/day      | the snapshot is written only when the state **changes**, plus a forced refresh every 10 min → ~150/day      |
| CPU per HTTP request       | 10 ms         | `fetch()` reads one KV key and returns a slice of it; it never queries D1 or renders                        |
| D1 row writes              | 100k/day      | ~15/min ≈ 21k/day; `checks` is a 1-hour rolling window, `daily` is the history                              |
| Subrequests per invocation | 50            | five probes                                                                                                 |
| Cron triggers              | 5 per account | one                                                                                                         |

Incidents open after **two** consecutive failing checks and resolve after **two** consecutive good
ones, so one blip (a deploy, a container restart) never becomes an incident.

## Local development

```sh
pnpm -C packages/status run test         # probes, state machine, schema, a real cycle on node:sqlite, render
pnpm -C packages/status run check-types  # Worker types for src, Node types for the tests
pnpm -C packages/status run build        # dist/worker.js — the bundle the apply uploads
pnpm -C packages/status run gen:brand    # src/brand.generated.ts — the logo + favicon, from packages/brand
```

> **The header lockup and the favicon are generated, not written.** `scripts/gen-brand.ts` renders
> `AlethiaLockup tag="labs"` and lifts its CSS from `packages/brand/src/tokens.css`, so this page
> draws exactly the main site's logo. `tests/brand.test.ts` fails when `src/brand.generated.ts`
> drifts from packages/brand; run `gen:brand` and commit the result.

> **`src/render.ts` holds its CSS in a template literal, so it must contain no backtick anywhere —
> comments included.** One backtick ends the string. `tests/render.test.ts` imports and renders the
> page, so it fails loudly instead of silently.

## Deploying

Nothing is provisioned by hand except the token. `infra/status/` owns every Cloudflare object behind
the hostname — the DNS record, the D1 database, the KV namespace, the Worker script and its bindings,
the cron trigger and the route. The Worker applies its own D1 schema on first run (`src/schema.ts`,
`IF NOT EXISTS` throughout), so there is no `wrangler d1 execute` step. **Do not `wrangler deploy`**:
OpenTofu owns the script, and two owners for one script is a split-brain.

It is applied by the maintainer, not by CI. Once:

1. **A Cloudflare API token** scoped to the `alethialabs.io` zone and its account: Account → Workers
   Scripts:Edit, Workers KV Storage:Edit, D1:Edit; Zone → Workers Routes:Edit, DNS:Edit, Zone:Read.
2. **The probe credential.** Generate it once (`openssl rand -hex 32`) and store it in
   `alethia/prod/env` as `ALETHIA_STATUS_PROBE_TOKEN`. The deploy emits it to the console
   (`scripts/ci/deploy-console-assemble-env.sh`); it takes effect on the next console deploy.

Then, from a checkout of `main`:

```sh
pnpm install --frozen-lockfile
pnpm -C packages/status run build
cd infra/status
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
export CLOUDFLARE_API_TOKEN=…                          # the token from step 1
export TF_VAR_cloudflare_account_id=…
export TF_VAR_status_probe_token="$(aws secretsmanager get-secret-value --secret-id alethia/prod/env \
  --query SecretString --output text | jq -r .ALETHIA_STATUS_PROBE_TOKEN)"
tofu plan -out tfplan && tofu apply tfplan
```

Within a minute `https://status.alethialabs.io` and `https://status.alethialabs.io/api/summary.json`
answer. Then set `NEXT_PUBLIC_STATUS_URL=https://status.alethialabs.io` in `alethia/prod/env` and
redeploy the console: that brings back the sign-in status line, the sidebar and support-hub links and
the email footer link. While it is unset, every one of those is hidden.

A code change to the Worker ships the same way: build, `tofu apply`. History is in D1, a separate
resource from the script, so it survives every redeploy; `prevent_destroy` guards the database.

## Consumers

`GET https://status.alethialabs.io/api/summary.json` is a public, versioned contract
(`SUMMARY_VERSION`), readable cross-origin. Component `id`s are the contract keys — renaming one breaks
every consumer, so treat them as frozen.
