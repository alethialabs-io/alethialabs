################################################################################
# General
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region for the GKE cluster"
}

variable "environment" {
  type        = string
  description = "Environment name (e.g. dev, staging, production)"
}

################################################################################
# Cluster
################################################################################

variable "cluster_name" {
  type        = string
  description = "Name of the GKE cluster"
}

variable "cluster_version" {
  type        = string
  description = "Kubernetes version for the GKE cluster"
  default     = "1.31"
}

variable "enable_autopilot" {
  type        = bool
  description = "Enable GKE Autopilot mode. When true, no separate node pool is created"
  default     = false
}

################################################################################
# Networking (from VPC module)
################################################################################

variable "network_name" {
  type        = string
  description = "Name of the VPC network"
}

variable "subnet_name" {
  type        = string
  description = "Name of the subnet for the GKE cluster"
}

variable "pod_ip_range_name" {
  type        = string
  description = "Name of the secondary IP range for pods"
}

variable "service_ip_range_name" {
  type        = string
  description = "Name of the secondary IP range for services"
}

################################################################################
# Node pool
################################################################################

variable "machine_types" {
  type        = list(string)
  description = "List of machine types for the default node pool (first element is used)"
  default     = ["e2-standard-4"]
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
  description = "Initial/desired number of nodes in the default node pool"
  default     = 2
}

variable "disk_size_gb" {
  type        = number
  description = "Disk size in GB for each node"
  default     = 100
}

variable "disk_type" {
  type        = string
  description = "Disk type for each node (pd-standard, pd-ssd, pd-balanced)"
  default     = "pd-standard"
}

################################################################################
# Access control
################################################################################

variable "master_authorized_cidr_blocks" {
  type = list(object({
    cidr_block   = string
    display_name = string
  }))
  description = "CIDR blocks authorized to access the GKE control plane"
  default = [{
    cidr_block   = "0.0.0.0/0"
    display_name = "All"
  }]
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
