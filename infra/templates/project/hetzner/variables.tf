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
  description = "Talos Linux version (e.g. v1.13.6)."
  type        = string
  default     = "v1.13.6"
}

variable "kubernetes_version" {
  # MUST be a concrete PATCH (e.g. 1.35.6), not a bare minor: Talos installs this verbatim as
  # the control-plane component image tag (registry.k8s.io/kube-apiserver:v<this>), and upstream
  # only publishes patch tags — a bare "1.35" yields an unpullable image (ImagePullBackOff).
  # Coupled to talos_version: Talos v1.13.6 supports k8s 1.31–1.36; we pin 1.35 (the newest minor
  # Cilium v1.19 officially tests). Leave empty ("") only to let Talos pick its own default (1.36).
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

variable "network_cidr" {
  description = "CIDR for the private Hetzner network the nodes attach to."
  type        = string
  default     = "10.0.0.0/16"
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
variable "pod_cidr" {
  description = "Pod network CIDR (Cilium). Must be a SUBNET of network_cidr and not overlap service_cidr or the node subnet."
  type        = string
  default     = "10.0.128.0/17"
}

variable "service_cidr" {
  description = "Service network CIDR. Must be a SUBNET of network_cidr and not overlap pod_cidr or the node subnet."
  type        = string
  default     = "10.0.96.0/19"
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

# ── Object Storage (S3-compatible) — see buckets.tf ────────────────────────────────

variable "buckets" {
  description = <<-EOT
    Object Storage buckets to provision via the aminueza/minio provider. Empty = none
    (the minio provider is then never exercised). `cors_origins` is IGNORED on Hetzner
    (the provider does not apply CORS to a non-MinIO backend); `encryption_enabled` is
    informational (Hetzner encrypts at rest automatically, no per-bucket toggle).
  EOT
  type = list(object({
    name               = string
    versioning         = optional(bool, false)
    encryption_enabled = optional(bool, true)
    public_access      = optional(bool, false)
    cors_origins       = optional(list(string), [])
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
