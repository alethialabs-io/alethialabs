# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Dedicated OpenReplay box — session replay for the console. OpenReplay's stack (ClickHouse + MinIO +
# Redis + Postgres + services) is far too heavy for the shared cx33 control-plane box, so it gets its
# own VM. Fronted by its OWN Cloudflare Tunnel (outbound; no public ports), exactly like the CP box.
# Mirrors infra/cp-hetzner. The OpenReplay app itself is installed post-provision (see README.md).

locals {
  labels = {
    project = "alethia"
    role    = "analytics-openreplay"
    managed = "opentofu"
  }
  openreplay_host = "openreplay.${var.domain}"
  access_count    = var.manage_access ? 1 : 0
}

resource "hcloud_ssh_key" "deploy" {
  name       = "alethia-openreplay-deploy"
  public_key = var.ssh_public_key
}

# SSH-only ingress; the tunnel dials out, so 80/443 stay closed.
resource "hcloud_firewall" "ssh" {
  name = "alethia-openreplay"
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_cidrs
  }
}

# OpenReplay is stateful (recordings in MinIO, events in ClickHouse/PG) — keep it on a data volume.
resource "hcloud_volume" "data" {
  name     = "alethia-openreplay-data"
  size     = var.data_volume_size
  location = var.location
  format   = "ext4"
  labels   = local.labels
}

resource "hcloud_server" "openreplay" {
  name        = "alethia-openreplay"
  server_type = var.server_type # cpx41 = 8 vCPU / 16 GB — OpenReplay's floor.
  image       = var.image
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.deploy.id]
  backups     = true
  labels      = local.labels

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    openreplay_domain = local.openreplay_host
  })

  lifecycle {
    ignore_changes = [ssh_keys]
  }
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.openreplay.id
  automount = true
}

resource "hcloud_firewall_attachment" "openreplay" {
  firewall_id = hcloud_firewall.ssh.id
  server_ids  = [hcloud_server.openreplay.id]
}

# ── Cloudflare Tunnel (dedicated) ────────────────────────────────────────────────
resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "openreplay" {
  account_id = var.cloudflare_account_id
  name       = "alethia-openreplay"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "openreplay" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.openreplay.id

  config {
    # OpenReplay's own ingress listens on :80 on the box (its installer sets up nginx/caddy).
    ingress_rule {
      hostname = local.openreplay_host
      service  = "http://localhost:80"
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# Run this token on the box:  cloudflared service install <token>   (see README).
output "tunnel_token" {
  description = "Connector token for the OpenReplay box's cloudflared."
  value       = cloudflare_zero_trust_tunnel_cloudflared.openreplay.tunnel_token
  sensitive   = true
}

output "server_ipv4" {
  value = hcloud_server.openreplay.ipv4_address
}

resource "cloudflare_record" "openreplay" {
  zone_id = var.cloudflare_zone_id
  name    = "openreplay"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.openreplay.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# ── Cloudflare Access — gate the OpenReplay dashboard, bypass /ingest ─────────────
resource "cloudflare_zero_trust_access_application" "openreplay_ingest" {
  count            = local.access_count
  zone_id          = var.cloudflare_zone_id
  name             = "OpenReplay ingest"
  domain           = "${local.openreplay_host}/ingest"
  type             = "self_hosted"
  session_duration = "24h"
}

resource "cloudflare_zero_trust_access_policy" "openreplay_ingest_bypass" {
  count          = local.access_count
  application_id = cloudflare_zero_trust_access_application.openreplay_ingest[0].id
  zone_id        = var.cloudflare_zone_id
  name           = "bypass — replay ingest is public"
  precedence     = 1
  decision       = "bypass"
  include {
    everyone = true
  }
}

resource "cloudflare_zero_trust_access_application" "openreplay_dashboard" {
  count            = local.access_count
  zone_id          = var.cloudflare_zone_id
  name             = "OpenReplay dashboard"
  domain           = local.openreplay_host
  type             = "self_hosted"
  session_duration = "24h"
}

resource "cloudflare_zero_trust_access_policy" "openreplay_dashboard_allow" {
  count          = local.access_count
  application_id = cloudflare_zero_trust_access_application.openreplay_dashboard[0].id
  zone_id        = var.cloudflare_zone_id
  name           = "team only"
  precedence     = 1
  decision       = "allow"
  include {
    email = var.access_emails
  }
}
