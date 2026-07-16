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
  description = "Availability zone ids to spread vswitches across (discovered; may be unknown at plan)"
}

variable "subnet_count" {
  type        = number
  default     = 3
  description = <<-EOT
    How many vswitches (subnets) to create. A PLAN-KNOWN static so the count resolves on the
    runner's `tofu plan -out` (unlike length(zone_ids), which is unknown at plan under the deferred
    RAM-OIDC provider). Each vswitch element()-indexes into zone_ids, wrapping if the region offers
    fewer zones than this — so it never errors on a short zone list. See #621/#608.
  EOT
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
