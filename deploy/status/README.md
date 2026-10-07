# Alethia status page (Gatus)

A self-hosted, Vercel-style status page for `status.alethialabs.io`, powered by
[Gatus](https://github.com/TwiN/gatus) — a lightweight Go uptime monitor with a
clean public page, configured entirely in `config.yaml`.

## Why a separate host

A status page must be **independent of the infrastructure it monitors**. If it
runs on the same cluster as production, a prod outage takes the status page down
with it — the one moment it has to be up. Run this on a small standalone box (a
cheap VPS, a different cloud account, or a distinct Hetzner host), **not** on the
production cluster.

The bundled `docker-compose.yml` runs **Gatus** behind **Caddy**, which terminates
HTTPS automatically (Let's Encrypt). Normally this is provisioned for you by
`infra/status/` (OpenTofu → tiny Hetzner box + cloud-init). To run it by hand on
any separate host:

1. Copy this `deploy/status/` directory to the separate host (or `git clone` the repo).
2. Bring it up with the domain + ACME email:
   ```sh
   ALETHIA_STATUS_DOMAIN=status.alethialabs.io ALETHIA_ACME_EMAIL=you@alethialabs.io \
     docker compose up -d
   ```
   Caddy serves `:80`/`:443` and proxies to Gatus internally; Gatus polls the
   endpoints in `config.yaml` and renders the public page. (Omit the env vars for a
   plain-HTTP `:80` local smoke test.)
3. **DNS:** in Cloudflare add `status` → this host's public IP as an **A record,
   DNS-only (grey cloud)** so Caddy's ACME HTTP-01 challenge reaches the box. Once
   the cert issues, `https://status.alethialabs.io` is live.

## What it checks

See `config.yaml`. Every row asserts `[STATUS] == 200`.

| Row | Probes | Down when |
|---|---|---|
| Website | `/` (anonymous `/` is the marketing app) | not 200, or slower than 800 ms |
| Console | `/login` | not 200 |
| API | `/api/health` (readiness) | the route answers 503 / `unhealthy` — the database is unreachable, or the health computation itself failed (fail-closed) |
| Background jobs | `/api/health` (readiness) | the aggregate is anything but `healthy` — a supervised background loop is stuck (`degraded`), or the API is down |
| Documentation | `/docs` | not 200 |

`/api/health` without a query is the **readiness** probe. Its body's `status` is
`healthy`, `degraded` or `unhealthy`, and it answers 503 only for `unhealthy`.
It never returns `ok` — that is the liveness path (`?shallow=1`) only. A
`degraded` API still serves requests, so the API row stays up and the
Background jobs row carries the degradation.

Background jobs reads the loop heartbeats of **one console process** — they are
kept in memory per process, not in the database. With more than one console
replica, the row reflects whichever replica answered that probe, so a loop stuck
on one replica can flap the row rather than hold it down.

If you add or change a `[BODY].status` condition on an `/api/health` row,
`apps/console/tests/api/health/status-page-monitors.test.ts` runs the real route
for every health state and fails if the condition names a value the route
cannot return, if Gatus could not parse a condition (an operator needs its
spaces: `[BODY].status==healthy` is invalid and always down), or if the row would
be down while everything is healthy. `apps/console/turbo.json` adds `config.yaml`
to that test's turbo inputs, so a change to this file alone re-runs it in CI
instead of hitting the cache.

## Next steps (optional)

- **Alerting:** Gatus supports Slack / email / PagerDuty / Discord alerts — add an
  `alerting:` block and per-endpoint `alerts:` to get notified on downtime.
- **Incidents:** Gatus has no rich incident timeline; if you later want
  manually-posted incident updates (like status.vercel.com), layer a static
  incidents section or revisit a dedicated tool.
