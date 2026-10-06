# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# THE node-pool contract (#5533, epic #5523): node labels, node taints and extra node pools, written
# the same way on every cloud, so that an alethia.yaml still works after a move from AWS to Hetzner.
#
# This file and render.tf are the contract. Every cloud lane (#5534 aws, #5535 azure, #5536 hetzner,
# #5537 gcp) copies these three `variable` blocks into infra/templates/project/<cloud>/variables.tf,
# and copies render.tf into its template. packages/core/cloud/nodepool_contract_test.go
# (`assertNodePoolContract`) then holds each copy to this one. The `type`, `default` and `nullable`
# must be token-equal, and EVERY `validation` block below must be present, both its condition and its
# error_message. A lane may ADD a validation of its own (a cloud's instance-type grammar, Hetzner
# refusing Spot) and may rewrite the `description`. It may not drop or weaken a rule here. `tofu
# test` runs this module against nodepool_contract.tftest.hcl, which proves that every refusal below
# refuses and that render.tf renders what the tests assert.
#
# The key and value rules are written ONCE, in Go: packages/core/nodekeys. The regexes below are
# copies of nodekeys.QualifiedKeyRegex, nodekeys.ValueRegex and nodekeys.ReservedDomainRegex, and
# packages/core/nodekeys/drift_test.go fails if they drift.
#
# The rules, and why each one is the strictest of the four clouds rather than one cloud's:
#
#   · KEY — a Kubernetes qualified key, [prefix/]name, with the name starting and ending with a
#     letter or digit. The WHOLE key, prefix included, is 1 to 63 characters, because the EKS
#     managed-node-group API caps label and taint keys there (CreateNodegroup.labels, Taint.key).
#   · VALUE — 1 to 63 of [-A-Za-z0-9_.], starting and ending with a letter or digit. A label value
#     may not be empty, because EKS refuses an empty one. A taint value may be left out, but when it
#     is set it may not be empty.
#   · RESERVED DOMAINS — a key whose prefix ENDS in kubernetes.io, k8s.io, karpenter.sh,
#     karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or
#     alethia.io is refused, for labels and taints alike. There is NO dot boundary: Karpenter's
#     NodePool CRD tests endsWith("kubernetes.io"), so `examplekubernetes.io/x` fails at apply and
#     must fail here at plan. There is also NO exception. That rules out node-role.kubernetes.io/ (the
#     issue's first draft) and node-restriction.kubernetes.io/ (which only the Karpenter knobs admit,
#     because Karpenter labels a node through the API). EKS managed node groups and GKE and AKS pools
#     label a node through the kubelet's --node-labels, and the kubelet admits only the kubernetes.io
#     keys that IsKubeletLabel allows (k8s.io/kubelet/pkg/apis/well_known_labels.go). Talos applies
#     machine.nodeLabels through its own controller, but the same prefixes are reserved there for the
#     same reason. The cloud domains are the UNION across clouds: a key that is refused on one cloud
#     must be refused on all of them, or a file valid on AWS breaks on AKS.
#   · PLATFORM-RESERVED — alethia.io is in that list because the platform writes there itself. Every
#     extra pool's nodes carry the label alethia.io/pool=<name>, which is the one pool selector that is
#     the same on every cloud. Every arm64 pool carries the taint alethia.io/arch=arm64:NoSchedule
#     (#5534), because Alethia's kaniko builds and generated Deployments are single-arch and pin no
#     arch, so arm64 capacity must never take an untolerated pod. The AWS Karpenter knobs refuse
#     alethia.io too (nodekeys), so no knob lets a user set or spoof either key.
#   · COUNTS — at most 24 node_labels and 25 labels per pool, so a pool's CONFIGURED labels, the
#     platform's alethia.io/pool included, number at most 50. At most 24 node_taints and 25 taints
#     per pool, so its configured taints, the platform's arm64 taint included, number at most 50. 50
#     is the EKS cap on the labels and on the taints of one managed NODE GROUP. It is not a cap on a
#     node: Kubernetes sets none, and a cloud may add taints of its own outside the pool's
#     configuration (GKE's kubernetes.io/arch=arm64:NoSchedule on an arm64 node, AKS's Spot taint),
#     so a GKE arm64 node can carry 51.
#   · POOLS — at most 10. A `name` matches ^[a-z][a-z0-9]{0,11}$ (AKS's Linux pool-name rule, the
#     strictest of the clouds) and is unique. It may not be `default`, `system`, `spot` or `pool<N>`,
#     because the templates already make pools with those names: the AKS default pool, its Spot pool,
#     and its positional pools pool1…poolN from machine_types[1..]. (`default` is also the render's key
#     for the default pool.) Sizes are whole numbers with 0 <= min_size <= desired_size <= max_size
#     and 1 <= max_size <= 100. desired_size defaults to min_size. arch is amd64 or arm64.
#     capacity_type is on-demand or spot, the same vocabulary as karpenter_capacity_types.
#   · TAINTS — effect is NoSchedule, PreferNoSchedule or NoExecute, and a key/effect pair appears at
#     most once in one list (the shape of karpenter_node_taints, #5527).
#
# What each lane renders. render.tf defines it, and the reference tftest's `assert` blocks pin it.
# Every lane carries both, so four lanes cannot render the semantics four ways. A lane BUILDS its
# pools' labels and taints from output/local nodepool_contract_render; computing them a second way
# beside it would let the asserted render and the applied pools disagree, and no test here sees it:
#
#   · node_labels reach EVERY Alethia-managed pool, the default pool included. A pool's own `labels`
#     win over node_labels for the same key. alethia.io/pool=<name> is added last and always wins.
#   · node_taints reach the EXTRA pools only. A taint on the default pool would strand the platform's
#     own add-ons, which tolerate none of the user's taints. A pool's own taint replaces a node_taint
#     with the same key and effect. The arm64 platform taint is added last.
#   · Defaults ({}, [], []) render the default pool with no labels and no taints. The template must
#     render byte-identically to one without these variables, which each lane proves in its own plan
#     test.
#
# What each lane maps, and what this file cannot express:
#
#   · TAINT EFFECT SPELLING. The contract spells effects the Kubernetes way. EKS (aws_eks_node_group
#     taint.effect) and GKE (node_config.taint.effect) want NO_SCHEDULE, PREFER_NO_SCHEDULE and
#     NO_EXECUTE. AKS (node_taints) wants the string "key=value:NoSchedule". Talos on Hetzner
#     (machine.nodeTaints) wants key → "value:NoSchedule". Each lane maps, and no lane changes the
#     contract spelling.
#   · THE ARM64 TAINT ON AWS KARPENTER (#5534). provisioner/karpenter.go's validate() refuses every
#     alethia.io key, because a USER may not write one. The renderer must therefore add the
#     platform's alethia.io/arch=arm64:NoSchedule taint to an arm64 NodePool AFTER validate() has
#     passed on the user's values, never by feeding it through the same input, or validate() refuses
#     the platform's own taint.
#   · HETZNER SIZE. Until the Hetzner autoscaler (#5538), a Hetzner pool is a FIXED group of
#     desired_size servers (min_size when desired_size is left out). min_size and max_size are still
#     validated, so the file stays valid when the autoscaler arrives.
#   · ISOLATION. An extra pool inherits every isolation control the default pool has: the same
#     subnets and security groups, the same disk encryption, IMDS hop limit 1 on AWS, and GKE workload
#     metadata. A pool that is cheaper because it is less isolated is a tenant-isolation regression.

variable "node_labels" {
  type        = map(string)
  default     = {}
  nullable    = false
  description = "Labels on the nodes of every Alethia-managed pool, the default pool included. A pool's own labels win for the same key. At most 24. Keys whose prefix ends in kubernetes.io, k8s.io, karpenter.sh, karpenter.k8s.aws, amazonaws.com, cloud.google.com, gke.io, azure.com, hetzner.cloud or alethia.io are refused."

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

variable "node_taints" {
  type = list(object({
    key    = string
    value  = optional(string)
    effect = string
  }))
  default     = []
  nullable    = false
  description = "Taints on the nodes of every extra pool (not the default pool, which runs the platform's add-ons). A pool's own taint wins for the same key and effect. At most 24. effect is one of NoSchedule, PreferNoSchedule and NoExecute."

  validation {
    condition     = length(var.node_taints) <= 24 && alltrue([for t in var.node_taints : contains(["NoSchedule", "PreferNoSchedule", "NoExecute"], t.effect)]) && length(distinct([for t in var.node_taints : "${t.key}:${t.effect}"])) == length(var.node_taints)
    error_message = "node_taints may hold at most 24 taints, each effect must be one of NoSchedule, PreferNoSchedule and NoExecute, and each key/effect pair may appear only once."
  }

  validation {
    condition = alltrue([for t in var.node_taints :
      length(t.key) <= 63 && can(regex("^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$", t.key)) &&
      (t.value == null ? true : length(t.value) >= 1 && length(t.value) <= 63 && can(regex("^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$", t.value)))
    ])
    error_message = "node_taints key must be [prefix/]name, 1 to 63 characters in all, where the prefix is a lowercase DNS name and the name starts and ends with a letter or digit and holds letters, digits, '-', '_' or '.'. A value, when set, is 1 to 63 of the same characters, starting and ending with a letter or digit."
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
}
