# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "grafana_instance_id" {
  description = "Grafana Cloud Prometheus instance ID / username. Injected at runtime."
  type        = string
}

variable "grafana_api_token" {
  description = "Grafana Cloud API token. Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "grafana_remote_write_url" {
  description = "Grafana Cloud Prometheus remote_write endpoint."
  type        = string
}
