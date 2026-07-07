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
  # t4g = Graviton ARM64 — matches the arm64 images; cheapest ARM general-purpose. Use an x86
  # t3.large only if amd64 images are what you deploy (pin an x86 AMI filter accordingly).
  description = "EC2 instance type."
  type        = string
  default     = "t4g.large"
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
