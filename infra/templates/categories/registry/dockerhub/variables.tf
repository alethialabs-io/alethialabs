# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "dockerhub_username" {
  description = "Docker Hub username. Injected at runtime from connector_credentials."
  type        = string
}

variable "dockerhub_access_token" {
  description = "Docker Hub access token (PAT). Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "dockerhub_namespace" {
  description = "Docker Hub namespace/organization (defaults to the username)."
  type        = string
  default     = ""
}

variable "repositories" {
  description = "Project registry component names (for reference/labelling)."
  type        = list(string)
  default     = []
}

variable "namespace" {
  description = "Kubernetes namespace for the image-pull secret."
  type        = string
  default     = "default"
}
