# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# BROKEN fixture for nodepool_contract_test.go: conforming/variables.tf with ONE change.
# node_taints is not declared, so a node_taints key in provider_config has no variable to land on.

variable "worker_count" {
  type    = number
  default = 3
}

variable "node_labels" {
  type = map( # every pool, the default pool included
    string
  )
  default     = {}
  nullable    = false
  description = "Hetzner: Labels on the nodes of every Alethia-managed pool, the default pool included. A pool's own labels win for the same key. At most 24. Keys whose prefix ends in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io are refused."

  validation {
    condition = length(var.node_labels) <= 24 && alltrue([for k, v in var.node_labels :
      length(k) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) >= 1 && length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ])
    error_message = "node_labels may hold at most 24 labels. A key is [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for k, v in var.node_labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ])
    error_message = "node_labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, the clouds and Alethia set those labels themselves, and a kubelet refuses to start with them. Use your own prefix, such as example.com/team, or none."
  }
}

variable "extra_node_pools" {
  type = list(object({
    name          = string
    instance_type = string
    min_size      = number
    max_size      = number
    desired_size  = optional(number)
    arch          = optional(string, "amd64")
    capacity_type = optional(string, "on-demand")
    labels        = optional(map(string), {})
    taints = optional(list(object({
      key    = string
      value  = optional(string)
      effect = string
    })), [])
  }))
  default     = []
  nullable    = false
  description = "Hetzner: Node pools beside the default pool. Each has a name, an instance type, min/max/desired sizes, an optional arch (amd64 or arm64) and capacity_type (on-demand or spot), and its own labels and taints. Its nodes carry the label alethia.io/pool=<name>; an arm64 pool also carries the taint alethia.io/arch=arm64:NoSchedule."

  validation {
    condition = length(var.extra_node_pools) <= 10 && length(distinct([for p in var.extra_node_pools : p.name])) == length(var.extra_node_pools) && alltrue([for p in var.extra_node_pools :
      can(regex("^[a-z][a-z0-9]{0,11}$", p.name)) && !contains(["default", "system", "spot"], p.name) && !can(regex("^pool[0-9]+$", p.name))
    ])
    error_message = "extra_node_pools may list at most 10 pools, each with a unique name of 1 to 12 lowercase letters and digits starting with a letter (the AKS pool-name rule, applied on every cloud so the file is portable). The names default, system, spot and pool1, pool2, ... are taken by pools Alethia already makes."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", p.instance_type)) && contains(["amd64", "arm64"], p.arch) && contains(["on-demand", "spot"], p.capacity_type)
    ])
    error_message = "extra_node_pools instance_type must be a cloud instance type such as \"m7g.large\", \"e2-standard-4\", \"Standard_D4s_v5\" or \"cx32\" (letters, digits, '.', '_' and '-', up to 64); arch must be \"amd64\" or \"arm64\"; capacity_type must be \"on-demand\" or \"spot\"."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      floor(p.min_size) == p.min_size && floor(p.max_size) == p.max_size && p.min_size >= 0 && p.max_size >= 1 && p.max_size <= 100 && p.min_size <= p.max_size &&
      (p.desired_size == null ? true : floor(p.desired_size) == p.desired_size && p.desired_size >= p.min_size && p.desired_size <= p.max_size)
    ])
    error_message = "extra_node_pools sizes must be whole numbers with 0 <= min_size <= desired_size <= max_size and 1 <= max_size <= 100. desired_size may be left out, and then equals min_size."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools : length(p.labels) <= 25]) && alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      length(k) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) >= 1 && length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ]]))
    error_message = "extra_node_pools labels may hold at most 25 labels per pool. A key is [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ]]))
    error_message = "extra_node_pools labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia labels every pool alethia.io/pool=<name> itself."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      length(p.taints) <= 25 && alltrue([for t in p.taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in p.taints : "${t.key}:${t.effect}"])) == length(p.taints)
    ])
    error_message = "extra_node_pools taints may hold at most 25 taints per pool, each effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once in a pool."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      length(t.key) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) >= 1 && length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ]]))
    error_message = "extra_node_pools taints key must be [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value, when set, is 1 to 63 of the same characters, starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ]]))
    error_message = "extra_node_pools taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia taints every arm64 pool alethia.io/arch=arm64:NoSchedule itself."
  }

  validation {
    condition     = alltrue([for p in var.extra_node_pools : p.capacity_type == "on-demand"])
    error_message = "extra_node_pools capacity_type must be \"on-demand\" on Hetzner, which sells no Spot capacity."
  }
}

variable "server_type" {
  type    = string
  default = "cx32"
}
