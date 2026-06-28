################################################################################
# Provider variables
################################################################################

variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region to deploy to"
}

################################################################################
# Naming variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed (e.g. staging, production)"
}

variable "project_name" {
  type        = string
  description = "Application name used as a prefix for resource names"
}

################################################################################
# Instance configuration
################################################################################

variable "tier" {
  type        = string
  description = "Service tier: BASIC (standalone) or STANDARD_HA (replicated)"
  default     = "BASIC"

  validation {
    condition     = contains(["BASIC", "STANDARD_HA"], var.tier)
    error_message = "tier must be BASIC or STANDARD_HA"
  }
}

variable "memory_size_gb" {
  type        = number
  description = "Redis memory size in GB"
  default     = 1
}

variable "redis_version" {
  type        = string
  description = "Redis version (e.g. REDIS_7_0, REDIS_6_X)"
  default     = "REDIS_7_0"
}

variable "auth_enabled" {
  type        = bool
  description = "Enable Redis AUTH for additional security"
  default     = true
}

variable "transit_encryption" {
  type        = bool
  description = "Enable in-transit encryption (TLS)"
  default     = false
}

variable "redis_configs" {
  type        = map(string)
  description = "Additional Redis configuration parameters"
  default     = {}
}

################################################################################
# Networking
################################################################################

variable "network_self_link" {
  type        = string
  description = "Self-link of the VPC network for private connectivity"
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
