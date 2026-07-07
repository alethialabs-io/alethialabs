# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "region" {
  # Must offer Yitian 710 ARM (g8y/c8y/r8y) ECS — e.g. eu-central-1, ap-southeast-1, cn-hangzhou.
  description = "Alibaba Cloud region."
  type        = string
  default     = "eu-central-1"
}

variable "zone_id" {
  description = "Availability zone (must have the ARM instance family). Empty = let the provider pick."
  type        = string
  default     = ""
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS edit + Cloudflare Tunnel (Zero Trust) perms."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the domain."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Zero Trust tunnel."
  type        = string
}

variable "domain" {
  description = "Apex domain served by the control plane."
  type        = string
  default     = "alethialabs.io"
}

variable "instance_type" {
  # g8y = Yitian 710 ARM64 (matches the arm64 images). ecs.g8y.large = 2 vCPU / 8 GB.
  description = "ECS instance type (must be ARM/Yitian, e.g. g8y/c8y/r8y)."
  type        = string
  default     = "ecs.g8y.large"
}

variable "system_disk_size" {
  description = "System disk size (GB) — holds Docker data (Postgres + object store)."
  type        = number
  default     = 40
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
