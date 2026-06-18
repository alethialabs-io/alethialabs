# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "gcp_project" {
  description = "GCP project ID."
  type        = string
}

variable "gcp_region" {
  # Must be a region with Tau T2A (ARM) availability (e.g. us-central1,
  # europe-west4, asia-southeast1) — the images are arm64-only.
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

variable "machine_type" {
  # t2a = Ampere Altra ARM64 (matches the arm64 images); t2a-standard-2 =
  # 2 vCPU / 8 GB, the cheapest tier with headroom for the bundle + a TF run.
  description = "GCE machine type (must be ARM/T2A)."
  type        = string
  default     = "t2a-standard-2"
}

variable "boot_disk_size" {
  description = "Boot disk size (GB) — holds Docker data (Postgres + object store)."
  type        = number
  default     = 30
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
