# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "doppler_token" {
  description = "Doppler API token (write-capable personal or Service-Account token). Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "doppler_project" {
  description = "Doppler project the managed secrets live in."
  type        = string
}

variable "doppler_config" {
  description = "Doppler config (environment) within the project."
  type        = string
}

variable "secret_names" {
  description = "Names of the Project secrets to manage in Doppler."
  type        = list(string)
  default     = []
}
