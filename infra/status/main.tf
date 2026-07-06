# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# status.alethialabs.io — a single tiny Hetzner VPS running ONLY the Gatus status
# page (Gatus + Caddy from deploy/status/). Intentionally SEPARATE from the prod
# control plane (infra/hetzner) so the status page stays up during a prod outage.
# DNS is set by the operator by hand (see outputs) — TF does not touch Cloudflare.

locals {
  labels = {
    project = "alethia"
    role    = "status"
    managed = "opentofu"
  }
}

resource "hcloud_ssh_key" "deploy" {
  name       = "alethia-status-deploy"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "web" {
  name = "alethia-status"

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

resource "hcloud_server" "status" {
  name         = "alethia-status"
  server_type  = var.server_type
  image        = var.image
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.deploy.id]
  backups      = true
  labels       = local.labels
  firewall_ids = [hcloud_firewall.web.id]

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url      = var.repo_url
    status_domain = "status.${var.domain}"
    acme_email    = var.acme_email
  })

  lifecycle {
    ignore_changes = [ssh_keys] # don't rebuild the box if the key rotates
  }
}
