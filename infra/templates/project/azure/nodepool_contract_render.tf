# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# What the node-pool contract RENDERS (#5533): the labels and taints each pool's nodes carry. Every
# cloud lane copies this file into its template unchanged, builds its pools' labels and taints FROM
# `local.nodepool_contract_render`, and maps only the spelling (variables.tf says how). The
# reference tftest's `assert` blocks pin the output for the acceptance cases, and every lane carries
# those asserts, so the merge rules, the alethia.io/pool label and the arm64 platform taint come out
# the same on every cloud.
#
# The key `default` is the default pool, which is why `default` is a reserved pool name. Taints are
# objects with `value = ""` when none was set. The contract refuses an empty value, so "" can only
# mean "no value".

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
