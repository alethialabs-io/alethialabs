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
# Every slot record must be proxied and on THIS tunnel. A slot whose DNS drifts is an
# env that resolves nowhere, and the symptom ("my env is broken") points at the app.
check "slot_dns_onto_tunnel" {
  assert {
    condition = alltrue([
      for r in cloudflare_record.env_slot :
      r.proxied && r.content == "${cloudflare_zero_trust_tunnel_cloudflared.sandbox.id}.cfargotunnel.com"
    ])
    error_message = "Every envN-<env_subdomain> must be a proxied CNAME onto THIS sandbox tunnel."
  }
}

# ONE label deep, always. Two levels is outside Cloudflare's Universal SSL and every
# request fails the TLS handshake before it is made — which is how the original
# *.dev.<domain> scheme shipped broken.
check "slot_hostnames_are_one_label_deep" {
  assert {
    condition     = alltrue([for r in cloudflare_record.env_slot : length(split(".", r.name)) == 1])
    error_message = "Env hostnames must be ONE label (envN-<sub>), not <slug>.<sub> — Universal SSL does not cover two levels."
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
    # tonumber() is load-bearing: `server_ids` is a set of NUMBER while
    # `hcloud_server.sandbox.id` is a STRING, so the un-cast comparison never matched and
    # this check failed on EVERY apply even though the firewall was correctly attached
    # (verified against the API on the first real apply — firewall 11386257 → server
    # 156573892, port 22 from the narrowed CIDR).
    #
    # A check that always fails is worse than no check: it teaches you to skim past
    # "Check block assertion failed", which is the one line that matters on the day the
    # attachment really is missing.
    condition     = contains(hcloud_firewall_attachment.sandbox.server_ids, tonumber(hcloud_server.sandbox.id))
    error_message = "The sandbox firewall must actually be attached to the sandbox server."
  }
}

# The whole point of the Primary IP is that the box comes back on the SAME address. If it
# ever comes back on a different one, ssh, rsync and DNS all break at once and the failure
# looks like "the box is broken" rather than "the IP moved".
#
# Both sides are strings here, so no cast is needed — but check the types before trusting
# an assertion: `firewall_is_attached` compared a set of NUMBER against a STRING id and so
# could never pass, failing on every apply while the firewall was correctly attached.
check "server_holds_the_persistent_ip" {
  assert {
    condition     = hcloud_server.sandbox.ipv4_address == hcloud_primary_ip.sandbox.ip_address
    error_message = "The sandbox server must hold the persistent Primary IP — a changed address breaks ssh, rsync and DNS together."
  }
}

# auto_delete would destroy the address with the server, silently reinstating the
# recycled-IP failure on the next restore. It is the one setting that makes reaping safe.
check "primary_ip_survives_the_server" {
  assert {
    condition     = hcloud_primary_ip.sandbox.auto_delete == false
    error_message = "The Primary IP must NOT auto-delete — it has to outlive the server for the address to be stable across reap/restore."
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
