# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "hcloud_token" {
  description = "Hetzner Cloud API token."
  type        = string
  sensitive   = true
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
  description = "SSH public key authorized on the server (CI deploy key)."
  type        = string
}

variable "server_type" {
  # CAX = Ampere ARM64 (matches the runner image's arm64 build). CAX21
  # (4 vCPU / 8 GB) is the cheapest tier with enough headroom to run the bundle
  # plus a Terraform job; bump to cax31 if it gets busy. CAX11 (4 GB) is too
  # tight when the runner executes.
  description = "Hetzner server type."
  type        = string
  default     = "cax21"
}

variable "location" {
  description = "Hetzner location (fsn1/nbg1/hel1 are EU)."
  type        = string
  default     = "fsn1"
}

variable "image" {
  description = "Base OS image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "data_volume_size" {
  # Separate volume so app data (Postgres + object storage) survives a server
  # replacement on `terraform apply`.
  description = "Size (GB) of the attached data volume."
  type        = number
  default     = 25
}

variable "ssh_allowed_cidrs" {
  # GitHub-hosted runner egress IPs are dynamic, so SSH stays open by default
  # (key-only auth). Restrict to a bastion/Tailscale range to harden later.
  description = "CIDRs allowed to reach SSH (22)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
