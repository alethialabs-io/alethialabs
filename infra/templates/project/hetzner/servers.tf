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
# SIZE: a FIXED group of desired_size servers, or min_size when desired_size is left out. Hetzner
# worker autoscaling is deferred (#5538, maintainer ruling 2026-10-08: the autoscaler would need the
# Talos join config in-cluster); max_size is validated but adds no servers.
#
# ADDRESSING (#5595): each pool gets its own /24 on the cluster's network, and its servers take .101
# onwards in it (at most 100 per pool, so it always fits). Once a pool holds a /24 it KEEPS it, and no
# two pools are ever given the same one:
#
#   free /24s  = the network's /24s numbered 1 .. min(count, 1024) - 1 (0 is the node subnet) that
#                overlap neither the pod CIDR nor the service CIDR, in ascending order;
#   hash slot  = free[ parseint(first 8 hex digits of sha256(name), 16) mod length(free) ].
#
#   A pool's /24, in order of precedence:
#     1. node_pool_subnet_index[name], when set (a pin; it moves an existing pool);
#     2. the number RECORDED for it in the ledger (below), when that number is still a free /24;
#     3. the /24 its servers already sit in, for a pool built before the ledger existed (upgrade);
#     4. otherwise it is NEW: its hash slot, if no 1-3 pool holds it and no new pool that sorts
#        before it by name has the same hash slot; else the lowest free /24 nobody holds, handed to
#        those pools in name order.
#   1-3 can still collide with each other (two pins, a pin onto a recorded pool, a hand-edited
#   ledger); that is refused at plan, naming the pools. Step 4 cannot collide, by construction.
#
# THE LEDGER lives in the cloud, not in state (maintainer ruling on #5595, option c). State cannot
# hold it: a value written from the allocation and read back by the allocation is a reference, and
# every reference is a graph edge, so each state-based shape is an OpenTofu cycle (the findings on
# #5595). The record is a label per pool on hcloud_firewall.this, which every cluster has (the network
# may be the user's), and it is read back through data.hcloud_firewalls with a selector built only
# from the cluster name — known at plan, depending on no resource — so the read has no edge to the
# write. A fresh cluster reads an empty list, so a fresh plan is deterministic.
#
#   key   = "subnet.alethia.io/<pool>"  (a pool name is ^[a-z][a-z0-9]{0,11}$, a legal key name)
#   value = the /24 NUMBER, such as "41". Never the CIDR: hcloud label values allow only letters,
#           digits, '-', '_' and '.', so '/' is illegal (hcloud-go labels.go valueRegexp).
#
# Removing a pool drops its label, so its /24 is free again. Someone who edits the labels by hand can
# move a pool: its subnet and servers are then replaced, and the plan shows it. That is the accepted
# cost of keeping the record outside state.
#
# There is deliberately NO ignore_changes on the subnet's ip_range: the plan shows exactly the /24
# each pool will hold, and the checks below read that same value.
#
# DEFAULTS: with extra_node_pools empty, neither data source is read and the firewall's labels are
# exactly local.default_labels, so the default plan is unchanged.
data "hcloud_firewalls" "node_pool_ledger" {
  count         = length(var.extra_node_pools) > 0 ? 1 : 0
  with_selector = "cluster=${local.cluster_name}"
}

# The servers of pools built before the ledger existed (step 3). Read by the `pool` label every pool
# server carries; a pool with no servers (min_size = 0) is invisible here and is allocated as new.
data "hcloud_servers" "node_pool_ledger" {
  count         = length(var.extra_node_pools) > 0 ? 1 : 0
  with_selector = "cluster=${local.cluster_name},pool"
}

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

  # The ledger's key prefix, and this cluster's firewall as the ledger read found it (null on a fresh
  # cluster, and whenever there are no pools, because the read is then skipped). Matched by NAME as
  # well as by the cluster label, so another firewall carrying the label can never be read as ours.
  node_pool_ledger_prefix   = "subnet.alethia.io/"
  node_pool_ledger_firewall = one([for fw in flatten(data.hcloud_firewalls.node_pool_ledger[*].firewalls) : fw if fw.name == local.cluster_name])

  # Step 2: pool name => the /24 number recorded for it. A value that is not a whole number, or that
  # is no longer a free /24 of this network (the network or the pod/service CIDRs changed), is not a
  # record.
  node_pool_recorded_slot = {
    for k, v in(local.node_pool_ledger_firewall == null ? {} : local.node_pool_ledger_firewall.labels) :
    trimprefix(k, local.node_pool_ledger_prefix) => tonumber(v)
    if startswith(k, local.node_pool_ledger_prefix) && contains(local.node_pool_free_slots, can(regex("^[1-9][0-9]{0,3}$", v)) ? tonumber(v) : -1)
  }

  # Step 3: pool name => the /24 number its existing servers sit in (the lowest, if they disagree).
  node_pool_slot_by_cidr = {
    for n in local.node_pool_free_slots : cidrsubnet(local.network_ip_range, local.node_pool_subnet_newbits, n) => n
  }
  node_pool_server_slots = {
    for srv in flatten(data.hcloud_servers.node_pool_ledger[*].servers) : srv.labels["pool"] => [
      for net in srv.network : local.node_pool_slot_by_cidr[cidrsubnet("${net.ip}/24", 0, 0)]
      if can(local.node_pool_slot_by_cidr[cidrsubnet("${net.ip}/24", 0, 0)])
    ]...
  }
  node_pool_existing_slot = {
    for name, slots in local.node_pool_server_slots : name => min(flatten(slots)...)
    if length(flatten(slots)) > 0
  }

  # Steps 1-3: the pools whose /24 is already decided.
  node_pool_held_slot = {
    for name in keys(local.node_pools) : name => (
      contains(keys(var.node_pool_subnet_index), name) ? var.node_pool_subnet_index[name] :
      contains(keys(local.node_pool_recorded_slot), name) ? local.node_pool_recorded_slot[name] :
      local.node_pool_existing_slot[name]
    )
    if contains(keys(var.node_pool_subnet_index), name) || contains(keys(local.node_pool_recorded_slot), name) || contains(keys(local.node_pool_existing_slot), name)
  }

  # Step 4, the new pools in name order, each with its hash slot (-1 when the network has no free /24).
  node_pool_new_names = sort([for name in keys(local.node_pools) : name if !contains(keys(local.node_pool_held_slot), name)])
  node_pool_hash_slot = {
    for name in local.node_pool_new_names : name => (
      length(local.node_pool_free_slots) == 0 ? -1 :
      local.node_pool_free_slots[parseint(substr(sha256(name), 0, 8), 16) % length(local.node_pool_free_slots)]
    )
  }

  # A new pool keeps its hash slot when no held pool takes it and no new pool sorted before it has the
  # same one. Winners are therefore distinct from each other and from every held /24.
  node_pool_hash_winners = {
    for i, name in local.node_pool_new_names : name => local.node_pool_hash_slot[name]
    if local.node_pool_hash_slot[name] > 0 &&
    !contains(values(local.node_pool_held_slot), local.node_pool_hash_slot[name]) &&
    !contains([for earlier in slice(local.node_pool_new_names, 0, i) : local.node_pool_hash_slot[earlier]], local.node_pool_hash_slot[name])
  }

  # The rest take the lowest free /24s that nobody holds, in name order: the i-th one gets the i-th.
  # null when the network has run out of free /24s (the fit check then says so).
  node_pool_spare_slots = [
    for n in local.node_pool_free_slots : n
    if !contains(values(local.node_pool_held_slot), n) && !contains(values(local.node_pool_hash_winners), n)
  ]
  node_pool_hash_losers = [for name in local.node_pool_new_names : name if !contains(keys(local.node_pool_hash_winners), name)]

  # Each pool's /24 number.
  node_pool_subnet_slot = merge(
    local.node_pool_held_slot,
    local.node_pool_hash_winners,
    { for i, name in local.node_pool_hash_losers : name => try(local.node_pool_spare_slots[i], null) },
  )

  # What this plan records in the ledger: every pool with a /24. Merged onto the firewall's labels.
  node_pool_ledger_labels = {
    for name, slot in local.node_pool_subnet_slot : "${local.node_pool_ledger_prefix}${name}" => tostring(slot)
    if slot != null
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
      ? (
        length(local.node_pool_free_slots) == 0
        ? "extra_node_pools pool \"${name}\" has no /24 to take: every /24 of the network (${local.network_ip_range}) after the node subnet overlaps the pod CIDR (${local.pod_cidr}) or the service CIDR (${local.service_cidr}). Use a larger network (a /16, the default, has 95 free /24s), or smaller pod and service CIDRs."
        : "extra_node_pools pool \"${name}\" has no /24 to take: other pools hold all ${length(local.node_pool_free_slots)} free /24s of the network (${local.network_ip_range}). Use a larger network, or fewer pools."
      )
      : "extra_node_pools pool \"${name}\" would take /24 number ${coalesce(slot, -1)} of the network (${local.network_ip_range})${contains(keys(var.node_pool_subnet_index), name) ? ", set by node_pool_subnet_index" : ""}, and that /24 is outside the network, is the node subnet (number 0), or overlaps the pod CIDR (${local.pod_cidr}) or the service CIDR (${local.service_cidr}). ${length(local.node_pool_free_slots) > 0 ? "The free /24 numbers lie between ${local.node_pool_free_slots[0]} and ${local.node_pool_free_slots[length(local.node_pool_free_slots) - 1]}; set node_pool_subnet_index for this pool to one that no other pool takes." : "The network has no free /24: use a larger network."}",
      "extra_node_pools pool \"${name}\" has no /24 it can take in the network (${local.network_ip_range}).",
    )
  }

  # The lowest free /24 no pool takes: the number the clash message suggests.
  node_pool_spare_slot = try([for n in local.node_pool_free_slots : n if !contains(values(local.node_pool_subnet_slot), n)][0], null)

  # What the clash check says when it fails, per pool. A NEW pool never clashes (step 4), so a clash is
  # between pools whose /24 was already decided: pinned by node_pool_subnet_index, or held (recorded in
  # the ledger, or where its servers already are). The message says which, so it is true either way.
  node_pool_subnet_clash_message = {
    for name, others in local.node_pool_subnet_clashes : name => format(
      "extra_node_pools pools %s would all take /24 number %d (%s) of the network. %s Do not set node_pool_subnet_index on a pool that already exists: that moves the pool's subnet and replaces its servers.",
      jsonencode(sort(concat([name], others))),
      coalesce(local.node_pool_subnet_slot[name], -1),
      coalesce(local.node_pool_subnet_cidrs[name], "none"),
      alltrue([for p in concat([name], others) : contains(keys(var.node_pool_subnet_index), p)])
      ? "node_pool_subnet_index sets each of them to this /24. Give each pool a different free /24 number${local.node_pool_spare_slot == null ? "" : ", such as ${local.node_pool_spare_slot}"}."
      : anytrue([for p in concat([name], others) : contains(keys(var.node_pool_subnet_index), p)])
      ? "${jsonencode(sort([for p in concat([name], others) : p if contains(keys(var.node_pool_subnet_index), p)]))} take it by node_pool_subnet_index, and ${jsonencode(sort([for p in concat([name], others) : p if !contains(keys(var.node_pool_subnet_index), p)]))} already hold it. Remove that node_pool_subnet_index entry, or set it to a different free /24 number${local.node_pool_spare_slot == null ? "" : ", such as ${local.node_pool_spare_slot}"}."
      : "Each of them already holds it, by the labels \"${local.node_pool_ledger_prefix}<pool>\" on the firewall \"${local.cluster_name}\" or by where its servers are. Those labels record each pool's /24 and are not meant to be edited by hand. Set node_pool_subnet_index for one of these pools to a free /24 number${local.node_pool_spare_slot == null ? "" : ", such as ${local.node_pool_spare_slot}"}, which replaces that pool's servers."
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

  # The ledger is written before any pool subnet exists, so an apply that fails part-way has already
  # recorded the /24s it was creating, and the next plan keeps them.
  depends_on = [hcloud_firewall.this]

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
