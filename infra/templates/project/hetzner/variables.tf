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

variable "region" {
  description = "Hetzner Cloud location (e.g. fsn1, nbg1, hel1, ash, hil)."
  type        = string
  default     = "fsn1"
}

variable "talos_version" {
  description = "Talos Linux version (e.g. v1.9.5)."
  type        = string
  default     = "v1.9.5"
}

variable "kubernetes_version" {
  description = "Kubernetes version. Leave empty (\"\") to let Talos pick its default."
  type        = string
  default     = ""
}

variable "control_plane_count" {
  description = "Number of control-plane nodes."
  type        = number
  default     = 1
}

variable "control_plane_server_type" {
  description = "Hetzner server type for control-plane nodes (cax* = arm64, cx* = amd64)."
  type        = string
  default     = "cax11"
}

variable "control_plane_arch" {
  description = "CPU architecture of the control-plane server type: arm64 (cax*) or amd64 (cx*)."
  type        = string
  default     = "arm64"

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
  description = "Hetzner server type for worker nodes (cax* = arm64, cx* = amd64)."
  type        = string
  default     = "cax11"
}

variable "worker_arch" {
  description = "CPU architecture of the worker server type: arm64 (cax*) or amd64 (cx*)."
  type        = string
  default     = "arm64"

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
