# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Public reachability for every branch environment, via one Cloudflare tunnel.
#
# TWO DELIBERATE DIFFERENCES FROM infra/cp-hetzner's tunnel:
#
#   1. `config_src = "local"`, not "cloudflare". The control plane has a fixed
#      ingress list, so remotely-managed config is right there. Here the ingress
#      changes every time an environment comes up or goes away, and a remotely-
#      managed tunnel takes its ingress from the dashboard — there is no way to add
#      a hostname from the box. Locally-managed lets scripts/box/env-tunnel.sh
#      regenerate config.yml from the registry and reload, with no API round-trip.
#
#   2. ONE WILDCARD DNS RECORD instead of a record per hostname. `*.dev` resolves
#      every present and future branch to the tunnel, so adding a branch never
#      touches Cloudflare — which is the whole point, since branches are created
#      several times a day.

resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "sandbox" {
  account_id = var.cloudflare_account_id
  name       = "alethia-sandbox"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "local"
}

# ── One record per env SLOT, and they are ONE LABEL DEEP for a reason ────────────
#
# The original design used a `*.dev` wildcard, giving branch envs
# <slug>.dev.<domain>. DNS resolved and the tunnel routed — and every one of them
# failed TLS:
#
#     dev.alethialabs.io          matched cert's "*.alethialabs.io"   OK
#     fix-trap.dev.alethialabs.io sslv3 alert handshake failure       FAILS
#
# Cloudflare's Universal SSL covers the apex and ONE level of subdomain. A name two
# levels deep is outside the certificate, so the handshake is refused before any
# request is made. Only an Advanced Certificate (paid) covers `*.dev.<domain>`, and
# paying roughly the price of the box to keep a prettier hostname is the wrong trade.
#
# So: one label. A record per registry SLOT rather than per branch, created once here,
# which means no Cloudflare API call during `env:up` and no wildcard catching every
# unregistered subdomain of the production zone.
#
# The registry already hands out a fixed console port per slot, so slot -> port ->
# hostname is one mapping the whole system agrees on:
#     slot 1  :3100  env1-dev.<domain>
#     slot 2  :3200  env2-dev.<domain>
resource "cloudflare_record" "env_slot" {
  count   = var.env_cap
  zone_id = var.cloudflare_zone_id
  name    = "env${count.index + 1}-${var.env_subdomain}"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.sandbox.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "alethia-sandbox: env slot ${count.index + 1}"
}

# The primary environment. This hostname is special: OAuth redirect URIs cannot be
# wildcarded, so social sign-in and the Stripe test webhook are registered against
# THIS name and nothing else. Branch envs under the wildcard are email-OTP only.
#
# allow_overwrite because this record already exists pointing at a named tunnel on
# the laptop (scripts/cf-named-tunnel.sh). Repointing it here is the intended
# migration — the Mac stops serving it.
resource "cloudflare_record" "env_primary" {
  zone_id         = var.cloudflare_zone_id
  name            = var.env_subdomain
  type            = "CNAME"
  content         = "${cloudflare_zero_trust_tunnel_cloudflared.sandbox.id}.cfargotunnel.com"
  proxied         = true
  ttl             = 1
  allow_overwrite = true
  comment         = "alethia-sandbox: primary env (social OAuth + Stripe webhooks)"
}

# The connector credentials for a LOCALLY-managed tunnel. cloudflared wants exactly
# these three fields as JSON; every one of them is already in state, so the box
# needs no interactive `cloudflared tunnel login` and no hand-scp'd file — which is
# the manual step this stack exists to delete.
locals {
  tunnel_credentials = jsonencode({
    AccountTag   = var.cloudflare_account_id
    TunnelID     = cloudflare_zero_trust_tunnel_cloudflared.sandbox.id
    TunnelSecret = random_id.tunnel_secret.b64_std
  })
}
