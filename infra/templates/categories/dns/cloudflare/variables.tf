# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "cloudflare_api_token" {
  description = "Cloudflare API token (Zone:DNS:Edit). Injected at runtime from connector_credentials."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for the managed domain."
  type        = string
}

variable "domain_name" {
  description = "The domain the cluster serves (e.g. example.com)."
  type        = string
}

variable "proxied" {
  description = "Whether records are proxied (orange-cloud) through Cloudflare."
  type        = bool
  default     = false
}

variable "ingress_hostname" {
  description = "Cluster ingress/load-balancer hostname the records point to. Empty until the ingress exists."
  type        = string
  default     = ""
}
