# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The sandbox box — one Hetzner VPS that runs every branch environment, so the Mac
# stops being a runtime. Deliberately NOT modelled on cp-hetzner's persistent
# control plane: there is no attached data volume, because this box is designed to
# be snapshot-and-deleted when idle (a stopped Hetzner server still bills; a deleted
# one does not, and a volume would keep billing after the delete).
#
# Durability therefore comes from the SNAPSHOT, not from a volume. That is an
# accepted trade: the only state worth keeping is seeded dev databases and warm
# node_modules, both cheap to rebuild.

locals {
  labels = {
    project     = "alethia"
    role        = "sandbox"
    managed     = "opentofu"
    Service     = "alethia-sandbox"
    Environment = var.environment
  }

  env_domain = "${var.env_subdomain}.${var.domain}"
}

resource "hcloud_ssh_key" "sandbox" {
  name       = "alethia-sandbox"
  public_key = var.ssh_public_key
}

resource "hcloud_server" "sandbox" {
  name        = "alethia-sandbox"
  server_type = var.server_type
  image       = var.image
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.sandbox.id]
  labels      = local.labels

  # No Hetzner backups (unlike cp-hetzner): reaping already snapshots on the way
  # down, and paying +20% to back up a box that is deleted most nights is waste.
  backups = false

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    env_domain = local.env_domain
    env_cap    = var.env_cap
  })

  lifecycle {
    ignore_changes = [
      ssh_keys, # don't rebuild the box when the key rotates
      image,    # env:up passes a snapshot id when restoring; that is not drift
    ]
  }
}
