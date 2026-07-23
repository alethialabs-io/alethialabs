# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "op_service_account_token" {
  description = "1Password Service Account token. Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "op_vault" {
  description = "1Password vault UUID the managed secrets live in."
  type        = string
}

variable "secret_names" {
  description = "Names of the Project secrets to manage in 1Password."
  type        = list(string)
  default     = []
}
