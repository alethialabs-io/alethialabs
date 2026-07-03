# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane — a single Hetzner VPS running the self-host
# bundle (app · docs · postgres · s3 · runner) behind Caddy. Cheapest viable
# footprint: one ARM box + one data volume; no managed services.

locals {
  labels = {
    project = "alethia"
    role    = "control-plane"
    managed = "opentofu"
  }
}

resource "hcloud_ssh_key" "deploy" {
  name       = "alethia-deploy"
  public_key = var.ssh_public_key
}

# SSH-only ingress. The control plane is fronted by a Cloudflare Tunnel
# (cloudflared dials OUT to Cloudflare's edge), so 80/443 stay closed — there is
# no public origin to reach. Harden further by restricting ssh_allowed_cidrs.
resource "hcloud_firewall" "web" {
  name = "alethia-cp"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_cidrs
  }
}

# Data volume — Postgres + object storage live here so they survive a server
# rebuild. Mounted + wired into Docker's data-root by cloud-init.
resource "hcloud_volume" "data" {
  name     = "alethia-data"
  size     = var.data_volume_size
  location = var.location
  format   = "ext4"
  labels   = local.labels
}

resource "hcloud_server" "cp" {
  name        = "alethia-cp"
  server_type = var.server_type
  image       = var.image
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.deploy.id]
  backups     = true # Hetzner server backups for off-box durability (+20%).
  labels      = local.labels

  # No volume.linux_device reference here (that would create a server↔volume
  # cycle); cloud-init discovers the mounted volume by glob instead.
  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url = var.repo_url
  })

  lifecycle {
    ignore_changes = [ssh_keys] # don't rebuild the box if the key rotates
  }
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.cp.id
  automount = true
}

# Actually enforce the SSH-only firewall on the box.
resource "hcloud_firewall_attachment" "cp" {
  firewall_id = hcloud_firewall.web.id
  server_ids  = [hcloud_server.cp.id]
}

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
# The origin is never exposed: cloudflared (a compose service on the box) dials OUT
# to Cloudflare and forwards the tunnel's ingress to Caddy over the internal network.
# TLS terminates at Cloudflare's edge. `config_src = "cloudflare"` = remotely-managed
# config, so the connector only needs the token (see the tunnel_token output → the
# TUNNEL_TOKEN env in ALETHIA_DOTENV).
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "cp" {
  account_id = var.cloudflare_account_id
  name       = "alethia-cp"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "cp" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.cp.id

  config {
    # Both the apex and www forward to Caddy, which stitches console + marketing +
    # docs + blog into the one origin.
    ingress_rule {
      hostname = var.domain
      service  = "http://caddy:80"
    }
    ingress_rule {
      hostname = "www.${var.domain}"
      service  = "http://caddy:80"
    }
    # Required catch-all.
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# DNS — proxied CNAMEs onto the tunnel (Cloudflare flattens the apex CNAME). Proxied
# is mandatory for cfargotunnel.com targets; ttl must be 1 (auto) when proxied.
resource "cloudflare_record" "apex" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cp.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "cloudflare_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.cp.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
