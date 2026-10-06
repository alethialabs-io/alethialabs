# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# THE node-pool contract (#5533, epic #5523): node labels, node taints and extra node pools, said the
# same way on every cloud so that an alethia.yaml survives a move from AWS to Hetzner.
#
# This file is the ONE place the rules are written. Every cloud lane (#5534 aws, #5535 azure, #5536
# hetzner, #5537 gcp) copies these three `variable` blocks into infra/templates/project/<cloud>/
# variables.tf. packages/core/cloud/nodepool_contract_test.go (`assertNodePoolContract`) then holds
# each copy to this one: the `type`, `default` and `nullable` must be token-equal, and EVERY
# `validation` block below must be present, condition and error_message both. A lane may ADD a
# validation of its own (a cloud's instance-type grammar, Hetzner refusing Spot) and may rewrite the
# `description`; it may not drop or weaken a rule here. `tofu test` runs this module against
# nodepool_contract.tftest.hcl, so every refusal below is proven to refuse, not just written down.
#
# The rules, and why each one is the strictest of the four clouds rather than any one cloud's:
#
#   · KEY GRAMMAR — a Kubernetes qualified key: [prefix/]name, a DNS-subdomain prefix of at most 253
#     characters (63 per DNS label) and a name of at most 63. Values: at most 63 of [-A-Za-z0-9_.],
#     starting and ending alphanumeric, or empty. Same expressions as karpenter_node_labels (#5544).
#   · RESERVED DOMAINS — a prefix ENDING in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws,
#     amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io is refused, for
#     labels and taints alike. There is deliberately NO dot boundary: Karpenter's NodePool CRD tests
#     endsWith("kubernetes.io"), so `examplekubernetes.io/x` fails at apply and must fail here at plan.
#     There is also NO exception — not node-role.kubernetes.io/ (the issue's first draft) and not
#     node-restriction.kubernetes.io/ (#5544's Karpenter-only exception). Managed node groups, GKE and
#     AKS pools and Talos all label a node through the kubelet's --node-labels, and the kubelet admits
#     only the kubernetes.io keys IsKubeletLabel allows
#     (k8s.io/kubelet/pkg/apis/well_known_labels.go); node-role and node-restriction are not among
#     them, so a portable file cannot carry either. The cloud domains are the UNION across clouds:
#     a key refused on one cloud must be refused on all, or a file valid on AWS breaks on AKS.
#   · PLATFORM-RESERVED — alethia.io is in that list because the platform writes there itself: every
#     extra pool's nodes carry the label alethia.io/pool=<name> (the one pool selector that is the same
#     on every cloud), and every arm64 pool carries the taint alethia.io/arch=arm64:NoSchedule (#5534:
#     Alethia's kaniko builds and generated Deployments are single-arch and pin no arch, so arm64
#     capacity must never take an untolerated pod). A user cannot spoof or remove either.
#   · POOLS — at most 10; `name` matches ^[a-z][a-z0-9]{0,11}$ (AKS's Linux pool-name rule, the
#     strictest), unique, and not default, system or spot, which name pools the templates already make.
#     0 <= min_size <= desired_size <= max_size, 1 <= max_size <= 100, all whole numbers;
#     desired_size defaults to min_size. arch is amd64 or arm64; capacity_type is on-demand or spot,
#     the vocabulary karpenter_capacity_types uses.
#   · TAINTS — effect is NoSchedule, PreferNoSchedule or NoExecute, and a key/effect pair appears at
#     most once in one list (the shape of karpenter_node_taints, #5527).
#
# What each lane renders (the semantics this file cannot express, held by each lane's tofu test):
#
#   · node_labels reach EVERY Alethia-managed pool, the default pool included. A pool's own `labels`
#     win over node_labels for the same key.
#   · node_taints reach the EXTRA pools only. A taint on the default pool would strand the platform's
#     own add-ons, which tolerate nothing of the user's. A pool's own taint wins over a node_taint
#     with the same key and effect.
#   · An extra pool inherits every isolation control the default pool has: the same subnets and
#     security groups, the same disk encryption, IMDS hop limit 1 on AWS, GKE workload metadata. A pool
#     that is cheaper because it is less isolated is a tenant-isolation regression.
#   · Defaults ({}, [], []) render byte-identically to a template without these variables.

variable "node_labels" {
  type        = map(string)
  default     = {}
  nullable    = false
  description = "Labels on the nodes of every Alethia-managed pool, the default pool included. A pool's own labels win for the same key. Keys in the kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud and alethia.io domains are refused."

  validation {
    condition = alltrue([for k, v in var.node_labels :
      length(split("/", k)[0]) <= 253 && alltrue([for l in split(".", split("/", k)[0]) : length(l) <= 63]) && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ])
    error_message = "node_labels keys must be Kubernetes label keys ([prefix/]name: a DNS prefix of up to 253 characters, 63 per label, and a name of up to 63 characters) and values must be up to 63 letters, digits, '-', '_' or '.', starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for k, v in var.node_labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ])
    error_message = "node_labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, the clouds and Alethia set those labels themselves, and a kubelet refuses to start with them. Use your own prefix, such as example.com/team, or none."
  }
}

variable "node_taints" {
  type = list(object({
    key    = string
    value  = optional(string)
    effect = string
  }))
  default     = []
  nullable    = false
  description = "Taints on the nodes of every extra pool (not the default pool, which runs the platform's add-ons). A pool's own taint wins for the same key and effect. effect is one of NoSchedule, PreferNoSchedule and NoExecute."

  validation {
    condition     = alltrue([for t in var.node_taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in var.node_taints : "${t.key}:${t.effect}"])) == length(var.node_taints)
    error_message = "node_taints effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once."
  }

  validation {
    condition = alltrue([for t in var.node_taints :
      length(split("/", t.key)[0]) <= 253 && alltrue([for l in split(".", split("/", t.key)[0]) : length(l) <= 63]) && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ])
    error_message = "node_taints key must be a Kubernetes key ([prefix/]name: a DNS prefix of up to 253 characters, 63 per label, and a name of up to 63 characters) and value, when set, up to 63 letters, digits, '-', '_' or '.', starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue([for t in var.node_taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ])
    error_message = "node_taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Kubernetes, the clouds and Alethia set those taints themselves (alethia.io/arch marks arm64 pools)."
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
  description = "Node pools beside the default pool. Each has a name, an instance type, min/max/desired sizes, an optional arch (amd64 or arm64) and capacity_type (on-demand or spot), and its own labels and taints. Its nodes carry the label alethia.io/pool=<name>; an arm64 pool also carries the taint alethia.io/arch=arm64:NoSchedule."

  validation {
    condition = length(var.extra_node_pools) <= 10 && length(distinct([for p in var.extra_node_pools : p.name])) == length(var.extra_node_pools) && alltrue([for p in var.extra_node_pools :
      can(regex("^[a-z][a-z0-9]{0,11}$", p.name)) && !contains(["default", "system", "spot"], p.name)
    ])
    error_message = "extra_node_pools may list at most 10 pools, each with a unique name of 1 to 12 lowercase letters and digits starting with a letter (the AKS pool-name rule, applied on every cloud so the file is portable). The names default, system and spot are taken by pools Alethia already makes."
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
    condition = alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      length(split("/", k)[0]) <= 253 && alltrue([for l in split(".", split("/", k)[0]) : length(l) <= 63]) && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", k)) &&
      length(v) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", v))
    ]]))
    error_message = "extra_node_pools labels keys must be Kubernetes label keys ([prefix/]name: a DNS prefix of up to 253 characters, 63 per label, and a name of up to 63 characters) and values must be up to 63 letters, digits, '-', '_' or '.', starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for k, v in p.labels :
      !strcontains(k, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", k)[0]))
    ]]))
    error_message = "extra_node_pools labels keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia labels every pool alethia.io/pool=<name> itself."
  }

  validation {
    condition = alltrue([for p in var.extra_node_pools :
      alltrue([for t in p.taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in p.taints : "${t.key}:${t.effect}"])) == length(p.taints)
    ])
    error_message = "extra_node_pools taints effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once in a pool."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      length(split("/", t.key)[0]) <= 253 && alltrue([for l in split(".", split("/", t.key)[0]) : length(l) <= 63]) && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ]]))
    error_message = "extra_node_pools taints key must be a Kubernetes key ([prefix/]name: a DNS prefix of up to 253 characters, 63 per label, and a name of up to 63 characters) and value, when set, up to 63 letters, digits, '-', '_' or '.', starting and ending with a letter or digit."
  }

  validation {
    condition = alltrue(flatten([for p in var.extra_node_pools : [for t in p.taints :
      !strcontains(t.key, "/") || !can(regex("(kubernetes\\.io|k8s\\.io|karpenter\\.sh|karpenter\\.k8s\\.aws|amazonaws\\.com|cloud\\.google\\.com|gke\\.io|azure\\.com|hetzner\\.cloud|alethia\\.io)$", split("/", t.key)[0]))
    ]]))
    error_message = "extra_node_pools taints keys may not use a prefix ending in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io. Alethia taints every arm64 pool alethia.io/arch=arm64:NoSchedule itself."
  }
}
