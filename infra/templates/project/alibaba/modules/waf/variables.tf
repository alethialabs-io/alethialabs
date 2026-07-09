# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "domain" {
  type        = string
  default     = ""
  description = "Domain to protect with the Web Application Firewall"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the WAF instance"
}
