# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "domain_name" {
  type        = string
  description = "Domain name to manage in AliDNS"
}

variable "group_name" {
  type        = string
  default     = ""
  description = "Logical group/zone name for the domain"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the domain"
}
