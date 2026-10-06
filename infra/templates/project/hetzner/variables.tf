# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "project_name" {
  description = "Project name; combined with environment to form the cluster name."
  type        = string
}

variable "environment" {
  description = "Environment name (e.g. dev, staging, prod)."
  type        = string
}

# Per-cloud classification labels emitted by the console (packages/core/cloud/tags.go, B1.2): the
# project's frozen classification dimensions plus the mandatory `alethia_project-id` /
# `alethia_environment-id` sweep handles (K8s/Talos label charset — `_`-namespaced, alnum bounds).
# Merged into local.default_labels (applied to every hcloud resource) and the CSI driver's
# volumeExtraLabels; the platform base labels always WIN a key collision (they sit on the merge RHS).
variable "classification_tags" {
  description = "Classification + sweep-handle labels to stamp on every hcloud resource + dynamically-provisioned volume. Platform base labels override on conflict."
  type        = map(string)
  default     = {}
}

variable "region" {
  description = "Hetzner Cloud location (e.g. fsn1, nbg1, hel1, ash, hil)."
  type        = string
  default     = "fsn1"
}

variable "talos_version" {
  # SSOT for the Talos↔Kubernetes window: packages/core/compat/matrix.json → components[talos].
  # The compat couplings drift test asserts this default is a recorded matrix release and that
  # kubernetes_version's minor stays inside its window (#1214).
  description = "Talos Linux version (e.g. v1.13.6)."
  type        = string
  default     = "v1.13.6"
}

# ── The Talos snapshot cache (#3027). Three modes, because an operator needs three different
#    things from it and a bare on/off cannot give them all.
#
# The snapshot `imager_image` builds is a pure function of (talos_version × architecture × location ×
# extension set). Rebuilding it per cluster cost 5–15 minutes on the critical path of every apply and
# was the dominant flake of the Hetzner floor — it blew its tofu deadline twice (#2458, run
# 33080748841) on the one resource that runs before any cluster exists, so losing it lost the run.
#
#   "enabled"  (default) look the cache up; a hit skips the build entirely; a miss builds and stamps
#              a persistent cache entry so the next apply hits. The entry carries NO `cluster` label,
#              which is what makes it invisible to the per-run teardown sweep — see image.tf.
#   "refresh"  skip the lookup; always build; stamp a NEWER entry, which wins the `most_recent`
#              lookup from then on. THE INVALIDATION LEVER: it supersedes a poisoned or suspect
#              cached snapshot without deleting anything, so a rollback is one more `refresh` away.
#   "disabled" skip the lookup; always build; stamp NO cache entry. Exactly the pre-#3027 behaviour:
#              a per-cluster image labelled `cluster=<name>`, reclaimed by the run's own teardown.
#              This is also the escape hatch from the lookup's trustworthiness gate — see image.tf.
#
# Cache entries are RETAINED INDEFINITELY and nothing deletes them on a timer. Reclaiming is a
# deliberate, human-invoked operation: `scripts/e2e/hcloud-image-cache.sh`. The reasoning (cost,
# rollback, and blast radius in an account shared with prod) is in image.tf's header.
variable "talos_image_cache" {
  description = "Talos snapshot cache mode: enabled (reuse a matching cached snapshot), refresh (rebuild and supersede the cached entry), disabled (rebuild per cluster, no cache entry — pre-#3027 behaviour)."
  type        = string
  default     = "enabled"

  validation {
    # A typo must be a REFUSAL, not a silent fallback. `var.talos_image_cache == "enabled"` decides
    # whether the lookup runs at all, so a misspelling that fell through to the default branch would
    # quietly restore the unconditional rebuild this variable exists to remove — green, slower, and
    # with nothing in the plan saying why.
    condition     = contains(["enabled", "refresh", "disabled"], var.talos_image_cache)
    error_message = "talos_image_cache must be exactly one of \"enabled\", \"refresh\" or \"disabled\"."
  }
}

variable "kubernetes_version" {
  # MUST be a concrete PATCH (e.g. 1.35.6), not a bare minor: Talos installs this verbatim as
  # the control-plane component image tag (registry.k8s.io/kube-apiserver:v<this>), and upstream
  # only publishes patch tags — a bare "1.35" yields an unpullable image (ImagePullBackOff).
  # Coupled to talos_version: Talos v1.13.6 supports k8s 1.31–1.36; we pin 1.35 (the newest minor
  # Cilium v1.19 officially tests). Leave empty ("") only to let Talos pick its own default (1.36).
  # SSOT for every component↔k8s window this minor must satisfy (talos / cilium / hcloud-csi):
  # packages/core/compat/matrix.json → components[*]; the compat drift test evaluates this pinned
  # version against the whole Hetzner component set and fails on any incompatibility (#1214).
  description = "Kubernetes version (concrete patch, e.g. 1.35.6); coupled to talos_version. Empty → Talos default."
  type        = string
  default     = "1.35.6"
}

variable "control_plane_count" {
  description = "Number of control-plane nodes."
  type        = number
  default     = 1
}

variable "control_plane_server_type" {
  # Equal to the catalog default, like worker_server_type: the provider moves both pools together.
  description = "Hetzner server type for control-plane nodes (cax* = arm64, cx*/cpx*/ccx* = amd64). Default cpx22 (2 vCPU / 4 GB, amd64) is a currently-orderable shared type; cax11 (ARM) is capacity-unreliable and cpx11 is retired."
  type        = string
  default     = "cpx22"
}

variable "control_plane_arch" {
  description = "CPU architecture of the control-plane server type: arm64 (cax*) or amd64 (cx*/cpx*/ccx*)."
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["arm64", "amd64"], var.control_plane_arch)
    error_message = "control_plane_arch must be either \"arm64\" or \"amd64\"."
  }
}

variable "worker_count" {
  description = "Number of worker nodes."
  type        = number
  default     = 1
}

variable "worker_server_type" {
  # Equal to the catalog default (packages/core/catalog/catalog.json compute.hetzner.default_instance)
  # by rule: TestTemplateNodeDefaultsEqualTheCatalog fails when they differ (#5266).
  description = "Hetzner server type for worker nodes (cax* = arm64, cx*/cpx*/ccx* = amd64). Default cpx22 (2 vCPU / 4 GB, amd64) is a currently-orderable shared type; cax11 (ARM) is capacity-unreliable and cpx11 is retired."
  type        = string
  default     = "cpx22"
}

variable "worker_arch" {
  description = "CPU architecture of the worker server type: arm64 (cax*) or amd64 (cx*/cpx*/ccx*)."
  type        = string
  default     = "amd64"

  validation {
    condition     = contains(["arm64", "amd64"], var.worker_arch)
    error_message = "worker_arch must be either \"arm64\" or \"amd64\"."
  }
}

# ── Private network: create one, or attach the one you already have ───────────────
#
# Greenfield (the default) creates `hcloud_network.this` from network_cidr. Brownfield
# (provision_network = false) attaches to the network named by network_id and takes its
# ip_range as the topology supernet — network_cidr is then IGNORED, because the network
# already exists and its range is not ours to choose.
#
# One thing brownfield still CREATES: the node subnet. Servers take their private IP from a
# subnet, and hcloud publishes no subnet data source, so there is nothing to look up and
# attach to — Alethia carves its own /24 (the first of the network's range) inside the
# network you named. That subnet range must be free; a collision is refused by the Hetzner
# API at apply, and no plan-time check can see it.
variable "provision_network" {
  description = "Create the private network (true, default), or attach the existing one named by network_id (false)."
  type        = bool
  default     = true
}

variable "network_id" {
  description = "Existing hcloud network to attach to when provision_network is false — its numeric id, or its name. Ignored when provision_network is true."
  type        = string
  default     = ""
}

variable "network_cidr" {
  description = "CIDR for the private Hetzner network the nodes attach to. Used only when provision_network is true; on an existing network the network's own ip_range is the supernet."
  type        = string
  default     = "10.0.0.0/16"
}

# #1987. ADDITIVE, never restrictive: these ranges are permitted IN ADDITION to the rules the
# template already writes, so the empty default is behaviour-preserving and cannot lock the
# external runner out of a cluster it still has to provision. Read by hcloud_firewall.this.
variable "network_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "Extra source CIDRs permitted inbound to this network's nodes, on top of the template's own rules. Empty (the default) adds nothing."

  validation {
    # alltrue([]) is true, so the empty default passes without a special case.
    condition     = alltrue([for c in var.network_allowed_cidr_blocks : can(cidrhost(c, 0))])
    error_message = "network_allowed_cidr_blocks must all be valid CIDRs (e.g. 10.1.0.0/16)."
  }
}

# Pod + service CIDRs are SUBNETS of network_cidr (Cilium native routing over the
# Hetzner private network). Keeping pods inside the network supernet — and setting
# ipv4NativeRoutingCIDR = network_cidr in cilium.tf — is what the canonical
# hcloud-k8s reference does for a private-network cluster, and it is REQUIRED for
# cross-node reachability: a control-plane pod (the apiserver) replies to a remote
# worker pod over the host netns, and the node's `network_cidr via <gw> dev eth1`
# route only covers the reply when the pod IP is inside network_cidr. Disjoint pod
# CIDRs (e.g. 10.244.0.0/16) leave the host with no route to remote pods AND fall
# outside the private-network firewall allow rule → cross-node pod→apiserver breaks.
#
# NULL BY DEFAULT, and that is the fix for the brownfield path rather than a convenience. These used
# to default to a split of 10.0.0.0/16 — the DEFAULT network_cidr — while `provision_network = false`
# ignores network_cidr entirely and takes the attached network's own ip_range as the supernet. The
# canvas hides the CIDR field on that path too, so a user attaching a 10.20.0.0/16 got pod/service
# CIDRs from a network they were not using, and the byo_network_guard precondition below then
# blocked the apply fail-closed. Unset means "derive from the network that actually resolved", which
# is correct on BOTH paths; a caller that names them explicitly still overrides, and is still held
# to the same invariants.
variable "pod_cidr" {
  description = "Pod network CIDR (Cilium). Defaults to the upper half of the resolved network's range. Must be a SUBNET of it and not overlap service_cidr or the node subnet."
  type        = string
  default     = null
}

variable "service_cidr" {
  description = "Service network CIDR. Defaults to a /19 inside the resolved network's range. Must be a SUBNET of it and not overlap pod_cidr or the node subnet."
  type        = string
  default     = null
}

# Optional, for the in-cluster hcloud-cloud-controller-manager secret ONLY.
# The hcloud/imager providers themselves read HCLOUD_TOKEN from the env (never
# this variable). The runner may pass the same token via TF_VAR_hcloud_token so
# the CCM (which runs inside the cluster and cannot see our env) can create
# LoadBalancers / route the private network. If left empty the CCM secret is
# still created empty and can be patched out-of-band later.
variable "hcloud_token" {
  description = "Hetzner token for the in-cluster hcloud CCM secret (optional; env HCLOUD_TOKEN drives the providers)."
  type        = string
  default     = ""
  sensitive   = true
}

# ── DNS (hcloud Zones) — see dns.tf ────────────────────────────────────────
#
# Hetzner's DNS moved onto the Cloud API in 2025 (zones are project-scoped and authenticated
# by the same HCLOUD_TOKEN as everything else here; zones can no longer be created under the
# retired dns.hetzner.com console). The hcloud provider carries it natively from 1.56 —
# `hcloud_zone`, `hcloud_zone_rrset` — which is why this is a build and not the architectural
# ceiling that Hetzner TLS and WAF genuinely are (see infra/offer-exclusions.yaml).

variable "cloud_dns_enabled" {
  description = "Create and manage the hcloud DNS zone in-template (parity with Route 53 / Cloud DNS / Azure DNS). When false, an existing zone id (dns_hosted_zone) is used and nothing is created."
  type        = bool
  default     = false
}

variable "dns_main_domain" {
  description = "Apex domain of the zone (e.g. example.com). Required when cloud_dns_enabled is true."
  type        = string
  default     = ""
}

variable "dns_hosted_zone" {
  description = "Existing hcloud DNS zone id, used when cloud_dns_enabled is false. Reported on the dns_zone_id output so the rest of the platform reads one name either way."
  type        = string
  default     = ""
}

variable "dns_zone_ttl" {
  description = "Default TTL (seconds) for records in the created zone."
  type        = number
  default     = 3600
}

# ── Object Storage (S3-compatible) — see buckets.tf ────────────────────────────────

variable "buckets" {
  description = <<-EOT
    Object Storage buckets to provision via the aminueza/minio provider. Empty = none
    (the minio provider is then never exercised).

    `cors_origins` builds a minio_s3_bucket_cors rule for any bucket that asks for one (#4320).
    The provider runs in s3_compat_mode, which names CORS among the features it SKIPS rather than
    fails when a backend does not implement them — so a CORS request here is honoured where Hetzner
    supports it and is a no-op where it does not, never an apply error.

    There is no `encryption_enabled` (#4320): Hetzner Object Storage supports exactly one
    encryption type, SSE-C — per-request keys the caller supplies — and no bucket-level
    default-encryption configuration, so no resource could write it. Objects are encrypted at rest
    regardless. An old tfvars still carrying the key is harmless: tofu drops object attributes the
    declared type omits.
  EOT
  type = list(object({
    name          = string
    versioning    = optional(bool, false)
    public_access = optional(bool, false)
    cors_origins  = optional(list(string), [])
  }))
  default = []
}

variable "hetzner_s3_endpoint" {
  description = "Hetzner Object Storage S3 endpoint HOST, no scheme (e.g. fsn1.your-objectstorage.com). Only used when var.buckets is non-empty."
  type        = string
  default     = "fsn1.your-objectstorage.com"
}

variable "hetzner_s3_region" {
  description = "Hetzner Object Storage location/region (fsn1, nbg1, hel1)."
  type        = string
  default     = "fsn1"
}

variable "hetzner_s3_access_key" {
  description = "Hetzner Object Storage S3 access key (distinct from the Cloud API token; manually generated in the Hetzner Console). Empty when no buckets are provisioned."
  type        = string
  default     = ""
  sensitive   = true
}

variable "hetzner_s3_secret_key" {
  description = "Hetzner Object Storage S3 secret key. Empty when no buckets are provisioned."
  type        = string
  default     = ""
  sensitive   = true
}

variable "admin_kubeconfig_cert_lifetime" {
  description = "TTL for the Talos admin kubeconfig client cert (.cluster.adminKubeconfig.certLifetime). Pinned LOW (default 1h) so every minted admin kubeconfig is short-lived; the Talos default is 1 year. Go time.Duration format."
  type        = string
  # 1h, the same order as the GCP/Azure admin tokens (#5326). A system:masters certificate cannot be
  # revoked short of a CA rotation, and the runner refuses to hand a user an admin kubeconfig whose
  # certificate outlives 8h (mintAdminLifetimeCap in apps/runner/internal/agent/kubeconfig_mint.go),
  # so a cluster still at the old 24h refuses admin mints until its next deploy applies this.
  # Nothing in the platform holds one certificate for longer than a step: the dedicated deploy
  # re-mints from the state's talosconfig before each post-apply step, and probe, drift and destroy
  # mint per use (#5330, packages/core/provisioner/talos_remint.go). The `kubeconfig` output's
  # stored certificate is therefore stale an hour after each apply, by design; nothing reads it.
  # Changing this on an existing cluster is a no-reboot apply on Talos v1.13.6: the whole `.cluster`
  # section is CanApplyImmediate (see #5331 for the sources).
  default = "1h0m0s"
  validation {
    # A parseable, non-trivial duration — reject an empty/garbage value that would silently fall back
    # to Talos's 1-year default and defeat the short-lived posture.
    condition     = can(regex("^[0-9]+(h|m|s|ms)([0-9]+(m|s|ms))*$", var.admin_kubeconfig_cert_lifetime))
    error_message = "admin_kubeconfig_cert_lifetime must be a Go duration like 24h0m0s or 1h."
  }
}

# In-cluster container-registry hosts the kubelet must be able to pull from over plain HTTP.
#
# A Hetzner `registry` node is an in-cluster Harbor exposed as a ClusterIP with TLS off (Hetzner has
# no registry product and a canvas node carries no domain, so the cluster network is the only address
# it has). containerd attempts HTTPS for any non-localhost host, so without a mirror entry the
# kubelet cannot pull from it AT ALL — and the failure surfaces as an auth error, not a TLS one.
#
# SINGLE-CLOUD BY NATURE: no other cloud has an in-cluster registry, because every other cloud
# provisions a real one whose nodes authenticate with their own identity. Recorded as such in the
# template-parity board — never by widening template_parity.baseline, which may only decrease.
variable "incluster_registry_hosts" {
  description = "In-cluster registry hosts (registry-<name>.registries.svc.cluster.local) to trust over plain HTTP via a containerd mirror. Empty on a cluster with no registry node."
  type        = list(string)
  default     = []
}

# ── Node labels, node taints and extra worker pools (#5536, contract #5533) ───────────────────────
# The three blocks below are the cross-cloud node-pool contract, copied VERBATIM from
# packages/core/cloud/testdata/nodepool/reference/variables.tf: type, default, nullable and every
# validation. packages/core/cloud/nodepool_hetzner_test.go (assertNodePoolContract) fails if any of
# them drifts, and packages/core/nodekeys/drift_test.go holds the key regexes to the Go definition.
# extra_node_pools carries three Hetzner validations after the contract's (Spot refused, a Hetzner
# server type, arch matching the server type).
#
# How Talos builds them is in servers.tf and talos.tf. Defaults ({}, [], []) render the cluster
# exactly as before (nodepool_hetzner.tftest.hcl proves it).
#
# SIZE (contract: "HETZNER SIZE"). Hetzner has no autoscaler yet (#5538), so a pool is a FIXED
# group of desired_size servers, or min_size when desired_size is left out. max_size is validated
# and kept, so the same file stays valid when the autoscaler arrives; it does not add servers today.

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


  # ── Hetzner's own rules (#5536). The contract allows a lane to ADD validations; these are the
  #    three things the contract's grammar admits that a Hetzner pool cannot be.

  # Hetzner Cloud sells no interruptible capacity: there is no Spot, preemptible or low-priority
  # server, so "spot" here could only be honoured by silently building on-demand servers at the
  # on-demand price. Refused instead, so the bill is never a surprise.
  validation {
    condition     = alltrue([for p in var.extra_node_pools : p.capacity_type != "spot"])
    error_message = "extra_node_pools capacity_type \"spot\" is not available on Hetzner: Hetzner Cloud has no interruptible (Spot) servers, so every pool is on-demand. Leave capacity_type out, or set it to \"on-demand\"."
  }

  # A Hetzner server type is a family prefix and a two- or three-digit size: cx22, cpx31, ccx23
  # (amd64) or cax21 (arm64). The size is compared with its own number's rendering, so "1e2", "-1",
  # "1.5" and a leading zero are refused. No regex(): this is the instance type, not a node key, and
  # nodekeys/drift_test.go classifies every regex() in this variable. Checked here, at plan, so an instance type from another cloud ("m7g.large") is refused
  # with a sentence instead of by the hcloud API halfway through an apply.
  validation {
    condition = alltrue([for p in var.extra_node_pools :
      anytrue([for f in ["cx", "cpx", "ccx", "cax"] : startswith(p.instance_type, f) && try(tostring(tonumber(trimprefix(p.instance_type, f))), "") == trimprefix(p.instance_type, f) && length(trimprefix(p.instance_type, f)) >= 2 && length(trimprefix(p.instance_type, f)) <= 3])
    ])
    error_message = "extra_node_pools instance_type must be a Hetzner Cloud server type: cx, cpx or ccx (amd64) or cax (arm64) followed by its size, such as \"cpx31\", \"ccx23\" or \"cax21\"."
  }

  # The server type decides the CPU: cax* is Ampere arm64, every other family is amd64. The pool's
  # arch picks the Talos image it boots and whether it carries the alethia.io/arch taint, so the two
  # must agree, as worker_arch must agree with worker_server_type (checks.tf).
  validation {
    condition     = alltrue([for p in var.extra_node_pools : startswith(p.instance_type, "cax") == (p.arch == "arm64")])
    error_message = "extra_node_pools arch must match instance_type on Hetzner: cax* server types are arm64 (set arch = \"arm64\"), and cx*, cpx* and ccx* are amd64 (leave arch out, or set \"amd64\")."
  }
}

# Hetzner only (#5536): which /24 of the cluster network an extra pool takes. Normally left empty —
# a pool's /24 is derived from its NAME (servers.tf, ADDRESSING), so adding, removing or reordering
# pools never moves another pool. Set an entry only when the plan refuses two pools on one /24, and
# set it for the pool being ADDED: changing it for a pool that exists moves its subnet and replaces
# its servers. A key that names no pool in extra_node_pools is refused (servers.tf), never ignored.
variable "node_pool_subnet_index" {
  type        = map(number)
  default     = {}
  nullable    = false
  description = "Hetzner only. For an extra pool, by name, the number of the /24 of the cluster network it takes (1 is the /24 after the node subnet). Leave empty: each pool's /24 is chosen from its name. Set it for a pool the plan reports on the same /24 as another."

  validation {
    condition     = alltrue([for name, n in var.node_pool_subnet_index : floor(n) == n && n >= 1])
    error_message = "node_pool_subnet_index values must be whole numbers of 1 or more: the number of a /24 of the cluster network after the node subnet (number 0)."
  }
}
