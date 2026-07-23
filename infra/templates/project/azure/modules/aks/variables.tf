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
  default     = "1.35"
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

################################################################################
# Access control (BYOC B4.1 knobs)
################################################################################

# BYOC AZ-SELF-ADMIN (mirror of EKS #470): grant the apply/runner identity the built-in
# "Azure Kubernetes Service RBAC Cluster Admin" role at cluster scope so it can install
# ArgoCD/add-ons over its own AAD workload-identity token. Default true; turning it off
# requires an admin_group_object_ids path (enforced by the top-level checks.tf guard).
variable "enable_creator_admin" {
  type        = bool
  description = "Grant the apply/runner identity RBAC Cluster Admin on the AKS cluster (default true). Mirrors EKS enable_creator_admin (#470)."
  default     = true
}

# Entra (Azure AD) group object IDs granted cluster-admin via AKS AAD-integrated RBAC.
# Empty (default) grants no customer admin group; the runner still gets admin via
# enable_creator_admin. (AAD + Azure RBAC are now always on — see main.tf.)
variable "admin_group_object_ids" {
  type        = list(string)
  description = "Entra group OBJECT IDs (GUIDs, not names) mapped to admin_group_object_ids for AAD-integrated cluster-admin. Empty = no customer admin group (the runner still gets admin via enable_creator_admin)."
  default     = []
}

# CIDRs allowed to reach the AKS public API server. Empty (default) leaves the
# api_server_access_profile block UNRENDERED — the API server stays reachable from
# all source IPs (the customer-specific default called out in the resource comment /
# suppressed AVD-AZU-0041), so provisioning by the external runner keeps working.
variable "authorized_ip_ranges" {
  type        = list(string)
  description = "CIDRs allowed to reach the AKS public API server (api_server_access_profile.authorized_ip_ranges). Empty = open to all source IPs (unchanged)."
  default     = []
}
