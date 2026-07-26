# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "infisical_host" {
  description = "Infisical API host (defaults to the SaaS endpoint; override for self-hosted)."
  type        = string
  default     = "https://app.infisical.com"
}

variable "infisical_client_id" {
  description = "Infisical machine-identity (Universal Auth) client id. Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "infisical_client_secret" {
  description = "Infisical machine-identity (Universal Auth) client secret. Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "infisical_workspace_id" {
  description = "Infisical workspace (project) id the managed secrets live in."
  type        = string
}

variable "infisical_env_slug" {
  description = "Infisical environment slug (e.g. dev, staging, prod)."
  type        = string
  default     = "dev"
}

variable "infisical_folder_path" {
  description = "Infisical secret folder path."
  type        = string
  default     = "/"
}

variable "secret_names" {
  description = "Names of the Project secrets to manage in Infisical."
  type        = list(string)
  default     = []
}
