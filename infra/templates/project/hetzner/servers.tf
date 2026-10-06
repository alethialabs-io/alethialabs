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
    network_id = local.network_id
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
    network_id = local.network_id
    ip         = each.value.private_ip
  }

  depends_on = [hcloud_network_subnet.nodes]

  lifecycle {
    ignore_changes = [user_data, image]
  }
}


# ── Extra worker pools (extra_node_pools, #5536; contract #5533) ──────────────────────────────────
#
# Each pool is a separate group of Talos workers with its own server type and count. Its servers are
# keyed "<pool>-<index>" (for_each, so removing a pool or shrinking one never renames another pool's
# servers) and join exactly as the default workers do: the same Talos secrets bundle
# (talos_machine_secrets.this), the same firewall, the same private network, and the same public
# IPv4 + IPv6 the default workers have, which talos_machine_configuration_apply needs to reach them.
# Nothing here is created when extra_node_pools is empty (the default).
#
# SIZE: a FIXED group of desired_size servers, or min_size when desired_size is left out. Hetzner has
# no autoscaler yet (#5538); max_size is validated but adds no servers today.
#
# ADDRESSING: each pool gets its own /24 on the cluster's network, the Nth /24 after the node subnet
# for the Nth pool in the list, and its servers take .101 onwards in it (at most 100 per pool, so it
# always fits). The pool's subnet is fixed at creation (ignore_changes below): reordering or removing
# pools later does NOT move an existing pool to another subnet, which would re-address its nodes.
# A new pool whose computed /24 is already held by an older pool is refused at plan
# (terraform_data.node_pool_subnets_guard) rather than by the hcloud API at apply.
locals {
  node_pools = {
    for i, p in var.extra_node_pools : p.name => {
      slot        = i + 1
      count       = p.desired_size != null ? p.desired_size : p.min_size
      server_type = p.instance_type
      arch        = p.arch
      image_id    = p.arch == "arm64" ? local.image_id_arm64 : local.image_id_amd64
    }
  }

  # The /24 a pool would take if created now, or null when the network has no such /24.
  node_pool_subnet_cidrs = {
    for name, p in local.node_pools :
    name => try(cidrsubnet(local.network_ip_range, 24 - tonumber(split("/", local.network_ip_range)[1]), p.slot), null)
  }

  node_pool_servers = merge({}, [
    for name, p in local.node_pools : {
      for i in range(p.count) : "${name}-${i}" => { pool = name, index = i }
    }
  ]...)
}

resource "hcloud_network_subnet" "node_pools" {
  for_each = local.node_pools

  network_id   = local.network_id
  type         = "cloud"
  network_zone = data.hcloud_location.selected.network_zone
  ip_range     = local.node_pool_subnet_cidrs[each.key]

  lifecycle {
    # A subnet's range cannot change in place (it is a replacement, under live servers). Fixed at
    # creation; see ADDRESSING above.
    ignore_changes = [ip_range]

    # The pool's /24 must exist in the network and stay clear of the pod and service CIDRs, which
    # Cilium routes natively over this same network. Same overlap test as checks.tf.
    precondition {
      condition = local.node_pool_subnet_cidrs[each.key] != null && alltrue([
        for other in [local.pod_cidr, local.service_cidr] : local.node_pool_subnet_cidrs[each.key] == null ? false : (
          cidrhost("${cidrhost(local.node_pool_subnet_cidrs[each.key], 0)}/${min(24, tonumber(split("/", other)[1]))}", 0)
          !=
          cidrhost("${cidrhost(other, 0)}/${min(24, tonumber(split("/", other)[1]))}", 0)
        )
      ])
      error_message = "extra_node_pools pool \"${each.key}\" needs /24 number ${each.value.slot} after the node subnet of the network (${local.network_ip_range}), and that /24 is outside the network or overlaps the pod CIDR (${local.pod_cidr}) or the service CIDR (${local.service_cidr}). Use a larger network (a /16 holds every pool), or fewer pools."
    }
  }
}

# Two pools on one /24 would be refused by the hcloud API at apply, after other servers were built.
# It can only happen when a pool's subnet was fixed at creation (above) and the list was later
# reordered or shortened so that a NEW pool computes the same /24.
resource "terraform_data" "node_pool_subnets_guard" {
  count = length(local.node_pools) > 0 ? 1 : 0

  lifecycle {
    precondition {
      condition     = length(distinct([for s in hcloud_network_subnet.node_pools : s.ip_range])) == length(hcloud_network_subnet.node_pools)
      error_message = "Two extra_node_pools would share one subnet: ${jsonencode({ for k, s in hcloud_network_subnet.node_pools : k => s.ip_range })}. An existing pool keeps the /24 it was created with, and a pool added since computes its /24 from its position in the list. Move the new pool to the end of extra_node_pools."
    }
  }
}

resource "hcloud_primary_ip" "node_pool_ipv4" {
  for_each = local.node_pool_servers

  name        = "${local.cluster_name}-${each.key}-ipv4"
  location    = data.hcloud_location.selected.name
  type        = "ipv4"
  auto_delete = false
  labels      = merge(local.default_labels, { role = "worker", pool = each.value.pool })
}

resource "hcloud_server" "node_pools" {
  for_each = local.node_pool_servers

  name        = "${local.cluster_name}-${each.key}"
  location    = data.hcloud_location.selected.name
  server_type = local.node_pools[each.value.pool].server_type
  image       = local.node_pools[each.value.pool].image_id
  user_data   = data.talos_machine_configuration.node_pool[each.value.pool].machine_configuration

  firewall_ids = [hcloud_firewall.this.id]

  labels = merge(local.default_labels, { role = "worker", pool = each.value.pool })

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.node_pool_ipv4[each.key].id
    ipv6_enabled = true
  }

  network {
    network_id = local.network_id
    ip         = cidrhost(hcloud_network_subnet.node_pools[each.value.pool].ip_range, each.value.index + 101)
  }

  depends_on = [hcloud_network_subnet.nodes, hcloud_network_subnet.node_pools]

  lifecycle {
    ignore_changes = [user_data, image]
  }
}
