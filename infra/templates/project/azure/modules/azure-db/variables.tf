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
# Database engine
################################################################################

variable "engine" {
  type        = string
  description = "Database engine type: postgres or mysql"
  default     = "postgres"

  validation {
    condition     = contains(["postgres", "mysql"], var.engine)
    error_message = "Engine must be either 'postgres' or 'mysql'."
  }
}

variable "engine_version" {
  type        = string
  description = "Database engine version"
  default     = "16"
}

################################################################################
# Server configuration
################################################################################

variable "sku_name" {
  type        = string
  description = "SKU name for the flexible server (e.g. B_Standard_B1ms, GP_Standard_D2s_v3)"
  default     = "B_Standard_B1ms"
}

variable "storage_mb" {
  type        = number
  description = "Max storage allowed for the server in megabytes"
  default     = 32768
}

variable "high_availability" {
  type        = bool
  description = "Whether to enable zone-redundant high availability"
  default     = false
}

variable "backup_retention_days" {
  type        = number
  description = "Backup retention period in days"
  default     = 7
}

variable "port" {
  type        = number
  description = "Database port (informational, used in outputs)"
  default     = 5432
}

variable "iam_auth" {
  type        = bool
  description = "Whether to enable Azure Active Directory (AAD) authentication on the Flexible Server"
  default     = false
}

################################################################################
# Networking
################################################################################

variable "subnet_id" {
  type        = string
  description = "Subnet ID for private access (delegated subnet)"
}

# BYOC B4.1: source CIDRs allowed to reach the Flexible Server via public-endpoint
# firewall rules. Empty (default) creates NO firewall rules — the server stays private
# (VNet-integrated, public access disabled) exactly as before. Non-empty adds one
# allow rule per CIDR on the server's public endpoint. NB: Azure firewall rules apply
# to the PUBLIC endpoint only and are mutually exclusive with delegated-subnet-only
# private access, so this knob is intended for public-access DB topologies.
variable "allowed_cidrs" {
  type        = list(string)
  description = "Source CIDRs allow-listed on the DB public endpoint (one firewall rule each). Empty = no rules, server stays private (unchanged)."
  default     = []
}
