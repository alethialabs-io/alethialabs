# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "region" {
  # Must offer the x86 g7 ECS family — e.g. eu-central-1, ap-southeast-1, cn-hangzhou.
  description = "Alibaba Cloud region."
  type        = string
  default     = "eu-central-1"
}

variable "zone_id" {
  description = "Availability zone (must have the x86 instance family). Empty = let the provider pick."
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
  # g7 = x86 general-purpose (matches the linux/amd64 self-host images). ecs.g7.large = 2 vCPU / 8 GB.
  description = "ECS instance type (x86 general-purpose, e.g. g7/c7/r7)."
  type        = string
  default     = "ecs.g7.large"
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

variable "environment" {
  description = "Deployment environment tag (FinOps) — Dev, Stage, or Prod."
  type        = string
  default     = "Prod"
  validation {
    condition     = contains(["Dev", "Stage", "Prod"], var.environment)
    error_message = "environment must be Dev, Stage, or Prod."
  }
}
