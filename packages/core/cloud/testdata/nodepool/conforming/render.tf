# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# A conforming lane's copy of reference/render.tf, unchanged, as every lane carries it.

locals {
  nodepool_contract_render = merge(
    {
      default = {
        labels = var.node_labels
        taints = []
      }
    },
    {
      for p in var.extra_node_pools : p.name => {
        labels = merge(var.node_labels, p.labels, { "alethia.io/pool" = p.name })
        taints = concat(
          [
            for t in var.node_taints : { key = t.key, value = t.value == null ? "" : t.value, effect = t.effect }
            if !contains([for pt in p.taints : "${pt.key}:${pt.effect}"], "${t.key}:${t.effect}")
          ],
          [for t in p.taints : { key = t.key, value = t.value == null ? "" : t.value, effect = t.effect }],
          p.arch == "arm64" ? [{ key = "alethia.io/arch", value = "arm64", effect = "NoSchedule" }] : [],
        )
      }
    },
  )
}

output "nodepool_contract_render" {
  description = "Per pool (the default pool under `default`), the labels and taints its nodes carry under the node-pool contract (#5533)."
  value       = local.nodepool_contract_render
}
