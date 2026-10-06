# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Node labels, node taints and named node pools on AKS (#5535), under the cross-cloud node-pool
# contract (#5533). The variables are in variables.tf; the render every cloud shares is
# nodepool_contract_render.tf. This file only MAPS that render to what azurerm wants, and builds
# nothing from the variables a second way: the labels and taints a pool gets are read from
# local.nodepool_contract_render, so the asserted render and the applied pools cannot disagree.
#
# What the mapping does, and nothing else:
#
#   · TAINT SPELLING. AKS takes a taint as one string. The contract's { key, value, effect } becomes
#     "key=value:Effect", or "key:Effect" when no value was set (the render carries that as "").
#   · SPOT. A spot pool is `priority = "Spot"`, evicted with Delete at up to the on-demand price
#     (spot_max_price = -1). AKS puts kubernetes.azure.com/scalesetpriority=spot on the label and the
#     taint of every spot node itself; azurerm documents that a Spot pool must ALSO declare both, or
#     the pool's node_labels / node_taints read back with them and plan a change on every run. They
#     are added here, after the render, because a user may not write azure.com keys.
#   · SIZE. desired_size defaults to min_size (the contract). It is node_count, the autoscaler's
#     starting point, between min_count and max_count.
#
# The positional pools from aks_instance_types (pool1…poolN) are NOT moved onto this: they are
# keyed by position, and re-keying them would replace live pools. They gain only node_labels, and
# only when node_labels is set.

locals {
  # The default pool's labels, as the module wants them. The render's `default` entry is exactly
  # var.node_labels, and the default pool takes no user taints (the contract: the platform add-ons
  # run there and tolerate none of them).
  aks_node_labels = local.nodepool_contract_render["default"].labels

  # One entry per extra_node_pools item, keyed by NAME, which is what the module's for_each keys
  # on: removing a pool from the middle of the list removes that pool and no other.
  aks_named_node_pools = {
    for p in var.extra_node_pools : p.name => {
      vm_size    = p.instance_type
      min_count  = p.min_size
      max_count  = p.max_size
      node_count = p.desired_size == null ? p.min_size : p.desired_size
      spot       = p.capacity_type == "spot"
      node_labels = merge(
        local.nodepool_contract_render[p.name].labels,
        p.capacity_type == "spot" ? { "kubernetes.azure.com/scalesetpriority" = "spot" } : {},
      )
      node_taints = concat(
        [for t in local.nodepool_contract_render[p.name].taints : t.value == "" ? "${t.key}:${t.effect}" : "${t.key}=${t.value}:${t.effect}"],
        p.capacity_type == "spot" ? ["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"] : [],
      )
    }
  }
}
