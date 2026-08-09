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

# The resource group Azure puts the agent pool, VMSS, NICs and load balancers in. Passed IN rather
# than composed here because it is a function of the PARENT resource group name and the cluster
# name together, and both are budgeted at the root (checks_naming.tf, NAMING-002) — deriving it here
# would mean composing two already-budgeted names against a third, tighter cap in a place the root's
# tests cannot reach. Left unset, Azure derives "MC_<resource_group>_<cluster_name>_<location>"
# server-side and rejects it at APPLY when that exceeds 80 characters (#1921). No default: a default
# would silently restore exactly that failure mode.
variable "node_resource_group" {
  type        = string
  description = "Name of the AKS-managed node resource group holding the agent pool infrastructure. Derived with an 80-character budget at the root (NAMING-002); ForceNew, so changing it REPLACES the cluster."
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

variable "os_disk_type" {
  type        = string
  description = "OS-disk placement: \"Managed\" or \"Ephemeral\". Null omits the argument, leaving Azure's default (Managed)."
  default     = null
}

################################################################################
# Spot node pool (aws parity: eks_ng_capacity_type)
################################################################################
# A Spot pool is a SEPARATE resource, never a flag on an existing one: priority /
# eviction_policy / spot_max_price are ForceNew, and AKS refuses a Spot default node pool.

variable "spot_enabled" {
  type        = bool
  description = "Create a Spot node pool alongside the on-demand pools."
  default     = false
}

variable "spot_max_price" {
  type        = number
  description = "Hourly ceiling (USD) for a Spot node; -1 means pay up to the on-demand price."
  default     = -1
}

variable "spot_eviction_policy" {
  type        = string
  description = "Eviction policy for reclaimed Spot nodes: \"Delete\" or \"Deallocate\"."
  default     = "Delete"
}

variable "spot_node_min_size" {
  type        = number
  description = "Minimum nodes in the Spot pool. 0 lets it scale to nothing."
  default     = 0
}

variable "spot_node_max_size" {
  type        = number
  description = "Maximum nodes in the Spot pool."
  default     = 3
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

# #2004. When set, the cluster runs as this user-assigned identity instead of a system-assigned one,
# and envelope-encrypts Kubernetes Secrets in etcd under secrets_kms_key_id. Both are set together
# or neither is: AKS encrypts AS the cluster identity, so a key without the identity that was
# granted access to it cannot be used. Empty (both) is the pre-#2004 shape.
variable "cluster_identity_id" {
  type        = string
  default     = ""
  description = "User-assigned identity resource id for the cluster. Empty uses a system-assigned identity."
}

variable "secrets_kms_key_id" {
  type        = string
  default     = ""
  description = "Key Vault key id for KMS etcd encryption of Kubernetes Secrets. Empty leaves Secrets under the platform key."
}
