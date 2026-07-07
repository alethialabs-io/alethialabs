# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "gcp_project" {
  description = "GCP project ID."
  type        = string
}

variable "gcp_region" {
  description = "GCP region."
  type        = string
  default     = "europe-west4"
}

variable "gcp_zone" {
  description = "GCP zone (within gcp_region)."
  type        = string
  default     = "europe-west4-a"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS edit + Cloudflare Tunnel (Zero Trust) perms on the zone/account."
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

variable "ssh_public_key" {
  description = "SSH public key authorized on the instance (CI deploy key). Reached via IAP only."
  type        = string
}

variable "machine_type" {
  # e2-standard-2 = 2 vCPU / 8 GB, x86 — GCP's cost-optimized family and the cheapest standard
  # tier with headroom for the compose bundle plus an OpenTofu run. x86 matches the linux/amd64
  # self-host images (as cp-hetzner now builds). Use an ARM t2a-standard-2 only if arm64 images
  # are published (and pin an arm64 boot image accordingly).
  description = "GCE machine type."
  type        = string
  default     = "e2-standard-2"
}

variable "boot_disk_size" {
  description = "Boot disk size (GB) — holds Docker data (Postgres + object storage)."
  type        = number
  default     = 30
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
