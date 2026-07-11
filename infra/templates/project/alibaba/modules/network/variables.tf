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
  description = "Availability zone ids to create vswitches in"
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
