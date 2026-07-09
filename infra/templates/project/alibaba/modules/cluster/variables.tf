# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "cluster_name" {
  type        = string
  description = "Name of the ACK managed Kubernetes cluster"
}

variable "cluster_version" {
  type        = string
  description = "Kubernetes version for the cluster"
}

variable "vswitch_ids" {
  type        = list(string)
  description = "Vswitch ids the cluster and node pool are placed in"
}

variable "pod_cidr" {
  type        = string
  default     = "172.20.0.0/16"
  description = "CIDR range for pods (must not overlap the VPC CIDR)"
}

variable "service_cidr" {
  type        = string
  default     = "172.21.0.0/20"
  description = "CIDR range for Kubernetes services (must not overlap the VPC or pod CIDR)"
}

variable "instance_types" {
  type        = list(string)
  description = "ECS instance types for the node pool"
}

variable "node_min_size" {
  type        = number
  description = "Minimum number of nodes in the node pool"
}

variable "node_max_size" {
  type        = number
  description = "Maximum number of nodes in the node pool"
}

variable "node_desired_size" {
  type        = number
  description = "Initial/desired number of nodes in the node pool"
}

variable "disk_size_gb" {
  type        = number
  description = "System disk size (GB) for each node"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the cluster and node pool"
}
