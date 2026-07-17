# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "vpc_name" {
  type        = string
  description = "Name of the VPC to create"
}

variable "network_cidr" {
  type        = string
  description = "Primary CIDR range for the VPC"
}

variable "vswitch_prefix" {
  type        = string
  description = "Name prefix for the created vswitches"
}

variable "zone_ids" {
  type        = list(string)
  description = "Discovered availability zone ids (apply-resolved VALUES; never drives a count — #621)"
}

variable "vswitch_count" {
  type        = number
  default     = 3
  description = "STATIC number of vswitches to create (plan-known; zone assignment wraps via element())"

  validation {
    condition     = var.vswitch_count >= 1 && var.vswitch_count <= 8
    error_message = "vswitch_count must be between 1 and 8."
  }
}

variable "single_cloud_nat" {
  type        = bool
  default     = true
  description = "Whether to provision a NAT gateway for outbound internet access"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to taggable resources"
}
