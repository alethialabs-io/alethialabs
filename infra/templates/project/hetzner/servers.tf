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
# ADDRESSING: each pool gets its own /24 on the cluster's network, and its servers take .101 onwards
# in it (at most 100 per pool, so it always fits). The /24 is chosen from the pool's NAME, never from
# its position in extra_node_pools, so adding, removing or reordering pools never moves another pool:
#
#   free /24s  = the network's /24s numbered 1 .. min(count, 1024) - 1 (0 is the node subnet) that
#                overlap neither the pod CIDR nor the service CIDR, in ascending order;
#   pool's /24 = free[ parseint(first 8 hex digits of sha256(name), 16) mod length(free) ],
#                or the /24 numbered node_pool_subnet_index[name] when that is set.
#
# Two names can land on the same /24. That is refused at plan, naming both pools, and the fix is to
# set node_pool_subnet_index for the pool being added (setting it on a pool that already exists moves
# that pool's subnet, which replaces its servers).
#
# There is deliberately NO ignore_changes on the subnet's ip_range: the address a pool computes is
# stable on its own, so the plan shows exactly the /24 each pool will hold and the checks below read
# that same value. A computed /24 changes only when node_pool_subnet_index, the network's range, or
# the pod/service CIDRs change, and the plan then shows the subnet and its servers being replaced
# rather than hiding it.
locals {
  node_pools = {
    for p in var.extra_node_pools : p.name => {
      count       = p.desired_size != null ? p.desired_size : p.min_size
      server_type = p.instance_type
      arch        = p.arch
      image_id    = p.arch == "arm64" ? local.image_id_arm64 : local.image_id_amd64
    }
  }

  # How many bits a /24 adds to the network's prefix, and the /24s a pool may take.
  node_pool_subnet_newbits = max(0, 24 - tonumber(split("/", local.network_ip_range)[1]))
  node_pool_free_slots = [
    for n in range(1, min(pow(2, local.node_pool_subnet_newbits), 1024)) : n
    if !local.node_pool_slot_overlaps_cluster_cidrs[n]
  ]

  # For each /24 number up to the cap: does it overlap the pod or the service CIDR? Same overlap test
  # as checks.tf, at the coarser of the two prefixes. (An override is checked by node_pool_subnet_fits,
  # which is not capped.)
  node_pool_slot_overlaps_cluster_cidrs = {
    for n in range(0, min(pow(2, local.node_pool_subnet_newbits), 1024)) : n => anytrue([
      for other in [local.pod_cidr, local.service_cidr] :
      cidrhost("${cidrhost(cidrsubnet(local.network_ip_range, local.node_pool_subnet_newbits, n), 0)}/${min(24, tonumber(split("/", other)[1]))}", 0)
      ==
      cidrhost("${cidrhost(other, 0)}/${min(24, tonumber(split("/", other)[1]))}", 0)
    ])
  }

  # Each pool's /24 number: its override, or the free /24 its name hashes to (null when the network
  # has no free /24 at all; the precondition below says so).
  node_pool_subnet_slot = {
    for name, p in local.node_pools : name => (
      contains(keys(var.node_pool_subnet_index), name) ? var.node_pool_subnet_index[name] : (
        length(local.node_pool_free_slots) == 0 ? null :
        local.node_pool_free_slots[parseint(substr(sha256(name), 0, 8), 16) % length(local.node_pool_free_slots)]
      )
    )
  }

  # The /24 each pool holds, or null when its number is outside the network.
  node_pool_subnet_cidrs = {
    for name, slot in local.node_pool_subnet_slot :
    name => slot == null ? null : try(cidrsubnet(local.network_ip_range, local.node_pool_subnet_newbits, slot), null)
  }

  # For each pool, the other pools on the same /24 (empty when it has its own).
  node_pool_subnet_clashes = {
    for name, slot in local.node_pool_subnet_slot : name => [
      for other, other_slot in local.node_pool_subnet_slot : other
      if other != name && slot != null && other_slot == slot
    ]
  }

  # Does each pool's /24 fit: inside the network, not the node subnet (number 0), and clear of the pod
  # and service CIDRs, which Cilium routes natively over this same network? Same overlap test as
  # checks.tf, at the coarser of the two prefixes. try(): a null or out-of-range number is a "no".
  node_pool_subnet_fits = {
    for name, cidr in local.node_pool_subnet_cidrs : name => try(local.node_pool_subnet_slot[name] >= 1 && alltrue([
      for other in [local.pod_cidr, local.service_cidr] :
      cidrhost("${cidrhost(cidr, 0)}/${min(24, tonumber(split("/", other)[1]))}", 0)
      !=
      cidrhost("${cidrhost(other, 0)}/${min(24, tonumber(split("/", other)[1]))}", 0)
    ]), false)
  }

  # What the fit check says when it fails, per pool.
  node_pool_subnet_misfit_message = {
    for name, slot in local.node_pool_subnet_slot : name => try(
      slot == null
      ? "extra_node_pools pool \"${name}\" has no /24 to take: every /24 of the network (${local.network_ip_range}) after the node subnet overlaps the pod CIDR (${local.pod_cidr}) or the service CIDR (${local.service_cidr}). Use a larger network (a /16, the default, has 95 free /24s), or smaller pod and service CIDRs."
      : "extra_node_pools pool \"${name}\" would take /24 number ${coalesce(slot, -1)} of the network (${local.network_ip_range})${contains(keys(var.node_pool_subnet_index), name) ? ", set by node_pool_subnet_index" : ""}, and that /24 is outside the network, is the node subnet (number 0), or overlaps the pod CIDR (${local.pod_cidr}) or the service CIDR (${local.service_cidr}). ${length(local.node_pool_free_slots) > 0 ? "The free /24 numbers lie between ${local.node_pool_free_slots[0]} and ${local.node_pool_free_slots[length(local.node_pool_free_slots) - 1]}; set node_pool_subnet_index for this pool to one that no other pool takes." : "The network has no free /24: use a larger network."}",
      "extra_node_pools pool \"${name}\" has no /24 it can take in the network (${local.network_ip_range}).",
    )
  }

  # The lowest free /24 no pool takes: the number the clash message suggests.
  node_pool_spare_slot = try([for n in local.node_pool_free_slots : n if !contains(values(local.node_pool_subnet_slot), n)][0], null)

  # What the clash check says when it fails, per pool. It says HOW the pools came to share the /24:
  # by the hash of their names, by node_pool_subnet_index, or some of each, so that the message is
  # true when both pools were set by hand.
  node_pool_subnet_clash_message = {
    for name, others in local.node_pool_subnet_clashes : name => format(
      "extra_node_pools pools %s would all take /24 number %d (%s) of the network. %s Do not set node_pool_subnet_index on a pool that already exists: that moves the pool's subnet and replaces its servers.",
      jsonencode(sort(concat([name], others))),
      coalesce(local.node_pool_subnet_slot[name], -1),
      coalesce(local.node_pool_subnet_cidrs[name], "none"),
      alltrue([for p in concat([name], others) : contains(keys(var.node_pool_subnet_index), p)])
      ? "node_pool_subnet_index sets each of them to this /24. Give each pool a different free /24 number${local.node_pool_spare_slot == null ? "" : ", such as ${local.node_pool_spare_slot}"}."
      : anytrue([for p in concat([name], others) : contains(keys(var.node_pool_subnet_index), p)])
      ? "${jsonencode(sort([for p in concat([name], others) : p if contains(keys(var.node_pool_subnet_index), p)]))} take it by node_pool_subnet_index, and ${jsonencode(sort([for p in concat([name], others) : p if !contains(keys(var.node_pool_subnet_index), p)]))} by the hash of the name. Set node_pool_subnet_index for the pool you are adding to a different free /24 number${local.node_pool_spare_slot == null ? "" : ", such as ${local.node_pool_spare_slot}"}, or rename it."
      : "A pool's /24 is chosen from its name, and these names land on the same one. Set node_pool_subnet_index for the pool you are adding, to a free /24 number${local.node_pool_spare_slot == null ? "" : " such as ${local.node_pool_spare_slot}"} (for example node_pool_subnet_index = { ${name} = ${coalesce(local.node_pool_spare_slot, 1)} }), or rename it."
    )
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
    # The pool's /24 must be inside the network, must not be the node subnet (number 0), and must stay
    # clear of the pod and service CIDRs, which Cilium routes natively over this same network.
    precondition {
      condition     = local.node_pool_subnet_fits[each.key]
      error_message = local.node_pool_subnet_misfit_message[each.key]
    }

    # No two pools on one /24: the hcloud API would refuse the second subnet at apply, after other
    # servers were built. Checked on the /24 each pool will hold (see ADDRESSING: no ignore_changes).
    precondition {
      condition     = length(local.node_pool_subnet_clashes[each.key]) == 0
      error_message = local.node_pool_subnet_clash_message[each.key]
    }
  }
}

# node_pool_subnet_index may only name pools that exist: an entry for a pool that is not in
# extra_node_pools (a typo, or a pool since removed) would otherwise be silently ignored. Nothing is
# created; the resource exists only to carry the check, and only when node_pool_subnet_index is set.
resource "terraform_data" "node_pool_subnets_guard" {
  count = length(var.node_pool_subnet_index) > 0 ? 1 : 0

  lifecycle {
    precondition {
      condition     = alltrue([for name in keys(var.node_pool_subnet_index) : contains(keys(local.node_pools), name)])
      error_message = "node_pool_subnet_index names ${jsonencode(sort([for name in keys(var.node_pool_subnet_index) : name if !contains(keys(local.node_pools), name)]))}, which is not a pool in extra_node_pools ${jsonencode(sort(keys(local.node_pools)))}. Each key must be the name of an extra pool; remove the entry or fix the name."
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
