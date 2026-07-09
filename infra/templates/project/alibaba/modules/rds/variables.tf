# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "instance_name" {
  type        = string
  description = "Name of the RDS instance"
}

variable "engine" {
  type        = string
  description = "Database engine (PostgreSQL or MySQL)"
}

variable "engine_version" {
  type        = string
  description = "Database engine version"
}

variable "instance_type" {
  type        = string
  description = "RDS instance class/type"
}

variable "port" {
  type        = number
  description = "Port the RDS instance listens on"
}

variable "backup_retention_days" {
  type        = number
  description = "Number of days to retain automated backups"
}

variable "vswitch_id" {
  type        = string
  description = "Vswitch id the RDS instance is placed in"
}

variable "database_name" {
  type        = string
  default     = "app"
  description = "Name of the default database to create"
}

variable "account_name" {
  type        = string
  default     = "app"
  description = "Name of the default database account to create"
}

variable "instance_storage" {
  type        = number
  default     = 20
  description = "Allocated storage (GB) for the RDS instance"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the RDS instance"
}
