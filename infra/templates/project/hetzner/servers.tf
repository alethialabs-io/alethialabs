# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

locals {
  # Per-node descriptors keyed by name for for_each stability.
  control_planes = {
    for i in range(var.control_plane_count) :
    "${local.cluster_name}-cp-${i + 1}" => {
      index       = i
      private_ip  = local.control_plane_private_ips[i]
      server_type = var.control_plane_server_type
      image_id    = local.cp_image_id
    }
  }

  workers = {
    for i in range(var.worker_count) :
    "${local.cluster_name}-worker-${i + 1}" => {
      index       = i
      private_ip  = local.worker_private_ips[i]
      server_type = var.worker_server_type
      image_id    = local.worker_image_id
    }
  }
}

resource "hcloud_server" "control_planes" {
  for_each = local.control_planes

  name        = each.key
  location    = data.hcloud_location.selected.name
  server_type = each.value.server_type
  image       = each.value.image_id
  user_data   = data.talos_machine_configuration.control_plane.machine_configuration

  firewall_ids = [hcloud_firewall.this.id]

  labels = merge(local.default_labels, { role = "control-plane" })

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.control_plane_ipv4[each.value.index].id
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.this.id
    ip         = each.value.private_ip
  }

  depends_on = [hcloud_network_subnet.nodes]

  lifecycle {
    # Talos re-images itself on boot; don't churn the server on config drift.
    ignore_changes = [user_data, image]
  }
}

resource "hcloud_server" "workers" {
  for_each = local.workers

  name        = each.key
  location    = data.hcloud_location.selected.name
  server_type = each.value.server_type
  image       = each.value.image_id
  user_data   = data.talos_machine_configuration.worker.machine_configuration

  firewall_ids = [hcloud_firewall.this.id]

  labels = merge(local.default_labels, { role = "worker" })

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.worker_ipv4[each.value.index].id
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.this.id
    ip         = each.value.private_ip
  }

  depends_on = [hcloud_network_subnet.nodes]

  lifecycle {
    ignore_changes = [user_data, image]
  }
}

