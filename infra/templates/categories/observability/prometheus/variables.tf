# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "prometheus_remote_write_url" {
  description = "Optional external Prometheus-compatible remote_write endpoint."
  type        = string
  default     = ""
}

variable "prometheus_remote_write_username" {
  description = "Optional remote_write basic-auth username. Injected at runtime."
  type        = string
  default     = ""
}

variable "prometheus_remote_write_password" {
  description = "Optional remote_write basic-auth password. Injected at runtime."
  type        = string
  sensitive   = true
  default     = ""
}

variable "prometheus_retention_days" {
  description = "Local retention window in days."
  type        = string
  default     = "15"
}
