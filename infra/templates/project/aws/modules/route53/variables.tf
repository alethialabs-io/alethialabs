# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "domain" {
  type        = string
  description = "The domain name for the hosted zone (e.g. example.com)."
}

variable "environment" {
  type        = string
  description = "Deployment environment (used in the zone comment)."
}

variable "zone_name" {
  type        = string
  default     = ""
  description = "Optional label for the zone's Name tag; defaults to the domain."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Additional tags to apply to the hosted zone."
}
