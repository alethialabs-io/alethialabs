# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The node-pool contract's render (#5533), copied unchanged from
# packages/core/cloud/testdata/nodepool/reference/render.tf. The worker pools in servers.tf and
# talos.tf build their Talos node labels and kubelet taints FROM local.nodepool_contract_render, and
# nodepool_contract.tftest.hcl asserts its output for every acceptance case, so the labels and taints
# a Hetzner node carries are the ones every other cloud renders. Only the spelling is mapped
# (talos.tf, local.nodepool_talos).

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
