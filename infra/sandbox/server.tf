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

# ── The address that outlives the box ─────────────────────────────────────────────
#
# THIS IS WHAT MAKES ROUTINE DELETION SAFE, and it costs EUR 0.50/mo.
#
# A stopped Hetzner server still bills in full ("you pay for a server ... for as long as
# it exists, regardless of whether it is turned on or not"), so deleting is the only way
# to stop the meter. The objection to deleting was fragility, and nearly all of it was
# one thing: Hetzner RECYCLES addresses. The first apply landed on an address a deleted
# box had held, and every ssh and rsync failed on a changed host key.
#
# A Primary IP is its own resource with its own lifetime. Held here with auto_delete off,
# it survives `destroy -target=hcloud_server.sandbox` and is re-attached on the next
# restore — so the address, the DNS answer and the known_hosts entry all stay put.
#
# delete_protection stops a stray `tofu destroy` taking it: losing it would silently
# reintroduce the recycling problem the next time the box comes back.
resource "hcloud_primary_ip" "sandbox" {
  name = "alethia-sandbox"
  type = "ipv4"
  # `location`, not `datacenter`: the provider requires exactly one of
  # [location, assignee_id], and the hcloud_datacenters data source is deprecated —
  # Hetzner returns HTTP 410 for the datacenters endpoints after 2026-10-01.
  location          = var.location
  auto_delete       = false
  delete_protection = true
  labels            = local.labels
}

resource "hcloud_server" "sandbox" {
  name        = "alethia-sandbox"
  server_type = var.server_type
  image       = var.image
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.sandbox.id]
  labels      = local.labels

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.sandbox.id
    # IPv6 primaries are free and Hetzner does not invoice them, so leave it on.
    ipv6_enabled = true
  }

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

      # user_data FORCES REPLACEMENT in the hcloud provider. Without this, bumping
      # env_cap from 3 to 4 planned "1 to add, 1 to destroy" — it would have deleted the
      # live box, its databases and every running environment, to change one number.
      #
      # cloud-init is a ONE-TIME BOOTSTRAP here. Everything that changes afterwards —
      # the box-side control scripts and /opt/alethia/box.env — is delivered by
      # provision_box on every `env:up`. So drift in user_data is expected and must
      # never be reconciled by rebuilding.
      user_data,
    ]
  }
}
