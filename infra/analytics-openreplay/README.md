# OpenReplay box (session replay)

> **Not the default.** For now the console uses **OpenReplay Cloud's free tier** (1,000 sessions/mo, $0,
> zero ops) — just set `NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY` in the vault (see `deploy/analytics/README.md`).
> This module is for **later**, only once you outgrow the free tier and want to self-host for unlimited
> sessions / full data ownership.

A dedicated Hetzner VM for **OpenReplay** — session replay for the console. Its stack (ClickHouse +
MinIO + Redis + Postgres + services) is too heavy for the shared `cx33` control-plane box, so it runs
on its own `cpx41` (8 vCPU / 16 GB), fronted by its **own Cloudflare Tunnel** (outbound-only, like the
CP box). This tofu provisions the box + tunnel + DNS + Cloudflare Access; the OpenReplay app itself is
installed once by hand (its installer is version/domain-specific).

## 1. Provision the box (tofu)
```bash
cd infra/analytics-openreplay
tofu init
tofu apply \
  -var hcloud_token=… -var cloudflare_api_token=… \
  -var cloudflare_zone_id=… -var cloudflare_account_id=… \
  -var ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)" \
  -var manage_access=true -var 'access_emails=["you@alethialabs.io"]'
tofu output -raw tunnel_token   # → used on the box below
tofu output server_ipv4
```
Creates: the VM (Docker + OpenReplay source pre-cloned to `/opt/openreplay` via cloud-init, SSH-only
firewall), a Cloudflare Tunnel, the `openreplay.alethialabs.io` CNAME, and Access apps (dashboard
team-only, `/ingest` bypassed).

## 2. Install OpenReplay on the box
```bash
ssh root@<server_ipv4>
cd /opt/openreplay/scripts/helmcharts   # (or /docker per the current upstream layout)
# Follow https://docs.openreplay.com/en/deployment/ for the single-node install, with:
#   DOMAIN_NAME=openreplay.alethialabs.io
# TLS: let Cloudflare terminate at the edge (the tunnel forwards plain HTTP to :80) — install
# OpenReplay WITHOUT its own Let's Encrypt, so its ingress serves plain :80.
# The installer prints a PROJECT_KEY and the ingest path.
```

## 3. Point the tunnel connector at the box
```bash
cloudflared service install <tunnel_token-from-step-1>   # connects openreplay.<domain> → localhost:80
```

## 4. Wire the console (vault)
Put these in the AWS Secrets Manager vault (`alethia/prod/env`) — the deploy assembler already emits
them (`.github/workflows/deploy-console.yml`):
```
NEXT_PUBLIC_OPENREPLAY_PROJECT_KEY=<project-key>
NEXT_PUBLIC_OPENREPLAY_INGEST=https://openreplay.alethialabs.io/ingest
```
Redeploy the console → the tracker (already wired in `components/providers/analytics-provider.tsx`,
input-obscured) starts recording.

## Verify
Load `https://alethialabs.io`, then open the OpenReplay dashboard (`https://openreplay.alethialabs.io`,
behind Cloudflare Access) — a session appears within ~1 min with inputs masked (Stripe card fields are
cross-origin iframes and are never captured).

## Cost note
This is a second always-on 16 GB box (~€25–30/mo). Umami alone (co-located, free) already covers
product analytics + funnels + Core Web Vitals; provision this only when you want session recordings.
