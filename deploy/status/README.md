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

See `config.yaml`. Each endpoint asserts `[STATUS] == 200` (plus a latency budget
on the console and a JSON-body check on `/api/health`, which returns
`{"status":"ok"}` after a DB ping). Add or adjust endpoints there.

## Next steps (optional)

- **Alerting:** Gatus supports Slack / email / PagerDuty / Discord alerts — add an
  `alerting:` block and per-endpoint `alerts:` to get notified on downtime.
- **Incidents:** Gatus has no rich incident timeline; if you later want
  manually-posted incident updates (like status.vercel.com), layer a static
  incidents section or revisit a dedicated tool.
