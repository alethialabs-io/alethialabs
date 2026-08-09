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

variable "disk_category" {
  type        = string
  default     = "cloud_essd"
  description = "System disk category for each node. The default is the value this module hardcoded before it was configurable."
}

variable "disk_performance_level" {
  type        = string
  default     = null
  description = "ESSD performance level in the API's own spelling (\"PL0\"-\"PL3\"), already resolved against disk_category by the caller. Null omits the argument."
}

variable "disk_provisioned_iops" {
  type        = number
  default     = null
  description = "Provisioned IOPS for the system disk, already resolved against disk_category by the caller. Null omits the argument."
}

variable "node_capacity_type" {
  type        = string
  default     = "NoSpot"
  description = "Bidding strategy for the node pool: NoSpot (on-demand), SpotWithPriceLimit, or SpotAsPriceGo."
}

variable "spot_price_limit" {
  type = list(object({
    instance_type = string
    price_limit   = string
  }))
  default     = []
  description = "Per-instance-type hourly bid ceilings, already emptied by the caller for any strategy but SpotWithPriceLimit. Empty renders no block."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the cluster and node pool"
}

# #1987. Empty (the default) means the node pool keeps only its ACK-managed security group.
variable "security_group_ids" {
  type        = list(string)
  default     = []
  description = "Extra security groups attached to the default node pool. Empty (the default) adds none."
}

# #2004. KMS key that envelope-encrypts Kubernetes Secrets in etcd. Empty (the default) leaves them
# under Alibaba's default key, which is what every cluster did before this landed.
variable "secrets_encryption_key_id" {
  type        = string
  default     = ""
  description = "KMS key id for Secrets envelope encryption. Empty disables it."
}
