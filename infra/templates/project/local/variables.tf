# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# --- Variables this module actually uses -----------------------------------

variable "project_name" {
  description = "Project name; combined with environment to form the (lowercase) kind cluster name."
  type        = string
}

variable "environment" {
  description = "Environment name (e.g. dev, prod, or a short unique suffix in the E2E test)."
  type        = string
}

variable "node_image" {
  description = "Optional kindest/node image (e.g. kindest/node:v1.31.0). Empty lets the provider pick its default."
  type        = string
  default     = ""
}

variable "wait_for_ready" {
  description = "Block `tofu apply` until the kind control plane is Ready."
  type        = bool
  default     = true
}

# --- Accepted-but-ignored inputs -------------------------------------------
#
# This module is driven through the HETZNER provider's ProviderTfvars (Provider=
# "hetzner" in the runner/test), which emits a Talos-shaped tfvars map. Declaring
# those variables here — even though a local kind cluster ignores them — keeps a
# hetzner-driven `-var-file` free of "value for undeclared variable" warnings and
# documents exactly what the driving code path passes.

variable "region" {
  description = "Ignored (no cloud region for a local cluster)."
  type        = string
  default     = "local"
}

variable "talos_version" {
  description = "Ignored (kind uses kindest/node, not Talos)."
  type        = string
  default     = ""
}

variable "kubernetes_version" {
  description = "Ignored here; kind selects its default node image (see node_image to pin one)."
  type        = string
  default     = ""
}

variable "control_plane_count" {
  description = "Ignored (kind creates a single-node control plane by default)."
  type        = number
  default     = 1
}

variable "control_plane_server_type" {
  description = "Ignored (no cloud instance types for a local cluster)."
  type        = string
  default     = ""
}

variable "control_plane_arch" {
  description = "Ignored (local host architecture)."
  type        = string
  default     = ""
}

variable "worker_count" {
  description = "Ignored (single-node kind by default)."
  type        = number
  default     = 0
}

variable "worker_server_type" {
  description = "Ignored (no cloud instance types for a local cluster)."
  type        = string
  default     = ""
}

variable "worker_arch" {
  description = "Ignored (local host architecture)."
  type        = string
  default     = ""
}

variable "network_cidr" {
  description = "Ignored (kind manages its own Docker network)."
  type        = string
  default     = ""
}

variable "pod_cidr" {
  description = "Ignored (kindnet manages pod networking)."
  type        = string
  default     = ""
}

variable "service_cidr" {
  description = "Ignored (kind manages the service network)."
  type        = string
  default     = ""
}

variable "hcloud_token" {
  description = "Ignored (no Hetzner CCM in a local cluster)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "buckets" {
  description = "Ignored (no Object Storage for a local cluster)."
  type        = list(any)
  default     = []
}

variable "hetzner_s3_region" {
  description = "Ignored (no Object Storage for a local cluster)."
  type        = string
  default     = ""
}

variable "hetzner_s3_endpoint" {
  description = "Ignored (no Object Storage for a local cluster)."
  type        = string
  default     = ""
}

variable "hetzner_s3_access_key" {
  description = "Ignored (no Object Storage for a local cluster)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "hetzner_s3_secret_key" {
  description = "Ignored (no Object Storage for a local cluster)."
  type        = string
  default     = ""
  sensitive   = true
}
