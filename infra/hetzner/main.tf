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
    managed = "terraform"
  }
}

resource "hcloud_ssh_key" "deploy" {
  name       = "alethia-deploy"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "web" {
  name = "alethia-cp"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_cidrs
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
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

# DNS — Caddy on the box terminates TLS, so records are unproxied (so Caddy's
# ACME challenge reaches it directly).
resource "cloudflare_record" "apex_a" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "A"
  content = hcloud_server.cp.ipv4_address
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "apex_aaaa" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "AAAA"
  content = hcloud_server.cp.ipv6_address
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "www_a" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "A"
  content = hcloud_server.cp.ipv4_address
  proxied = false
  ttl     = 300
}
