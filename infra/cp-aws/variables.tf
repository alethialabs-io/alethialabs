# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-1"
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
  # t3 = x86 burstable — matches the linux/amd64 self-host bundle images. t3.large = 2 vCPU / 8 GB,
  # the cheapest general-purpose tier with headroom for the compose bundle plus a TF run.
  description = "EC2 instance type (x86 — the app images are amd64)."
  type        = string
  default     = "t3.large"
}

variable "root_volume_size" {
  description = "Root gp3 EBS size (GB) — holds Docker data (Postgres + object store)."
  type        = number
  default     = 60
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
