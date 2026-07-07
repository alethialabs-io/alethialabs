# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "vault_address" {
  description = "Base URL of the Vault server. Injected at runtime from connector_credentials."
  type        = string
}

variable "vault_token" {
  description = "Vault token. Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "vault_mount_path" {
  description = "KV mount path."
  type        = string
  default     = "secret"
}

variable "vault_kv_version" {
  description = "KV engine version (1 or 2)."
  type        = string
  default     = "2"
}

variable "secret_names" {
  description = "Names of the Project secrets to manage in Vault."
  type        = list(string)
  default     = []
}
