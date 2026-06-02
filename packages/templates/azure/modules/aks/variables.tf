################################################################################
# Provider variables
################################################################################

variable "location" {
  type        = string
  description = "Azure region to deploy to"
}

################################################################################
# Utility variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed"
}

variable "project_name" {
  type        = string
  description = "Name of the project / client / product to be used in naming convention"
}

variable "resource_group_name" {
  type        = string
  description = "Name of the Azure resource group"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources"
}

################################################################################
# AKS Cluster Configuration
################################################################################

variable "cluster_name" {
  type        = string
  description = "Name of the AKS cluster"
}

variable "cluster_version" {
  type        = string
  description = "Kubernetes version for the AKS cluster"
  default     = "1.29"
}

################################################################################
# Networking variables
################################################################################

variable "vnet_subnet_id" {
  type        = string
  description = "Subnet ID for the AKS default node pool"
}

################################################################################
# Node pool configuration
################################################################################

variable "machine_types" {
  type        = list(string)
  description = "List of VM sizes for the node pools. First entry is used for the default pool."
  default     = ["Standard_D4s_v5"]
}

variable "node_min_size" {
  type        = number
  description = "Minimum number of nodes in the default node pool"
  default     = 1
}

variable "node_max_size" {
  type        = number
  description = "Maximum number of nodes in the default node pool"
  default     = 5
}

variable "node_desired_size" {
  type        = number
  description = "Desired (initial) number of nodes in the default node pool"
  default     = 2
}

variable "disk_size_gb" {
  type        = number
  description = "OS disk size in GB for each node"
  default     = 50
}
