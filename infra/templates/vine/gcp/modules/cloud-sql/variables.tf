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
# Networking
################################################################################

variable "network_self_link" {
  type        = string
  description = "Self-link of the VPC network for private IP connectivity"
}

################################################################################
# Engine configuration
################################################################################

variable "engine" {
  type        = string
  description = "Database engine: POSTGRES or MYSQL"
  default     = "POSTGRES"

  validation {
    condition     = contains(["POSTGRES", "MYSQL"], var.engine)
    error_message = "engine must be POSTGRES or MYSQL"
  }
}

variable "engine_version" {
  type        = string
  description = "Database engine version (e.g. 15 for PostgreSQL 15, 8_0 for MySQL 8.0)"
  default     = "15"
}

variable "tier" {
  type        = string
  description = "Cloud SQL machine tier (e.g. db-f1-micro, db-custom-2-8192)"
  default     = "db-f1-micro"
}

variable "disk_size" {
  type        = number
  description = "Disk size in GB"
  default     = 20
}

variable "high_availability" {
  type        = bool
  description = "Enable regional high availability (automatic failover)"
  default     = false
}

################################################################################
# Backup configuration
################################################################################

variable "backup_enabled" {
  type        = bool
  description = "Enable automated backups"
  default     = true
}

variable "backup_retention_days" {
  type        = number
  description = "Number of backups to retain"
  default     = 7
}

################################################################################
# Authentication
################################################################################

variable "iam_auth" {
  type        = bool
  description = "Enable Cloud IAM authentication for the database"
  default     = false
}

variable "port" {
  type        = number
  description = "Database port (defaults to 5432 for PostgreSQL, 3306 for MySQL)"
  default     = null
}

variable "authorized_networks" {
  type = list(object({
    name  = string
    value = string
  }))
  description = "List of authorized networks that can connect to Cloud SQL (each entry has a name and a CIDR value)"
  default     = []
}

################################################################################
# Labels
################################################################################

variable "labels" {
  type        = map(string)
  description = "Labels to apply to all resources"
  default     = {}
}
