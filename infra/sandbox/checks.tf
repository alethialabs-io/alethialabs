# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# checks.tf — post-plan invariants for the sandbox stack. Each of these has a
# specific failure it exists to catch loudly rather than at 2am over SSH.

# A remotely-managed tunnel takes its ingress from the Cloudflare dashboard, so the
# box could not add a hostname when a new branch env comes up — every env after the
# first would 404 with nothing in any log to explain it.
check "tunnel_is_locally_managed" {
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.sandbox.config_src == "local"
    error_message = "The sandbox tunnel must be locally-managed (config_src = \"local\"); the box rewrites ingress per env."
  }
}

# Unproxied, or pointed at a stale tunnel id, and every branch hostname resolves to
# nothing — the failure mode looks like "my env is broken" rather than "DNS is wrong".
check "wildcard_dns_onto_tunnel" {
  assert {
    condition = (
      cloudflare_record.env_wildcard.proxied &&
      cloudflare_record.env_wildcard.content == "${cloudflare_zero_trust_tunnel_cloudflared.sandbox.id}.cfargotunnel.com"
    )
    error_message = "*.<env_subdomain> must be a proxied CNAME onto THIS sandbox tunnel (<tunnel-id>.cfargotunnel.com)."
  }
}

# The primary hostname is the only one with OAuth redirect URIs and the Stripe test
# webhook registered against it. If it drifts off the tunnel, social sign-in breaks
# in a way that reads as an auth bug — prod OAuth has broken on exactly this before.
check "primary_dns_onto_tunnel" {
  assert {
    condition = (
      cloudflare_record.env_primary.proxied &&
      cloudflare_record.env_primary.content == "${cloudflare_zero_trust_tunnel_cloudflared.sandbox.id}.cfargotunnel.com"
    )
    error_message = "<env_subdomain> must be a proxied CNAME onto THIS sandbox tunnel; OAuth + Stripe are registered against it."
  }
}

# This box runs unreviewed branch code by design. Everything is reached through the
# tunnel, so any inbound rule other than SSH means something opened a public origin.
check "ssh_is_the_only_ingress" {
  assert {
    condition = (
      length(hcloud_firewall.sandbox.rule) == 1 &&
      one(hcloud_firewall.sandbox.rule).port == "22"
    )
    error_message = "The sandbox firewall must expose port 22 and nothing else — envs are reached via the tunnel, not a public port."
  }
}

# A firewall that exists but is attached to nothing is the classic silent misconfig.
check "firewall_is_attached" {
  assert {
    condition     = contains(hcloud_firewall_attachment.sandbox.server_ids, hcloud_server.sandbox.id)
    error_message = "The sandbox firewall must actually be attached to the sandbox server."
  }
}

# The env cap and the port pools in scripts/box/env-registry.sh are sized together;
# a cap the pools cannot satisfy fails at allocation time with a confusing
# "registry is inconsistent" rather than here.
check "env_cap_fits_the_port_pools" {
  assert {
    condition     = var.env_cap <= 6
    error_message = "env_cap exceeds the console/storage port pools in scripts/box/env-registry.sh (6 slots)."
  }
}
