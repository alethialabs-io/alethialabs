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

# The wildcard: *.dev.<domain> -> the tunnel. Proxied is mandatory for
# cfargotunnel.com targets, and ttl must be 1 (auto) when proxied.
resource "cloudflare_record" "env_wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = "*.${var.env_subdomain}"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.sandbox.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "alethia-sandbox: every branch env, no per-branch record needed"
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
