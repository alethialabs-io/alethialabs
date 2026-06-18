# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-1"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS edit on the zone."
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the domain."
  type        = string
}

variable "domain" {
  description = "Apex domain served by the control plane."
  type        = string
  default     = "alethialabs.io"
}

variable "ssh_public_key" {
  description = "SSH public key authorized on the instance (CI deploy key)."
  type        = string
}

variable "instance_type" {
  # t4g = Graviton ARM64 — matches the arm64 images; cheapest ARM general-purpose.
  description = "EC2 instance type."
  type        = string
  default     = "t4g.large"
}

variable "root_volume_size" {
  description = "Root gp3 EBS size (GB) — holds Docker data (Postgres + object store)."
  type        = number
  default     = 60
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to reach SSH (22)."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
