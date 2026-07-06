# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "datadog_api_key" {
  description = "Datadog API key. Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "datadog_app_key" {
  description = "Datadog application key. Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "datadog_site" {
  description = "Datadog site (e.g. datadoghq.com, datadoghq.eu)."
  type        = string
  default     = "datadoghq.com"
}
