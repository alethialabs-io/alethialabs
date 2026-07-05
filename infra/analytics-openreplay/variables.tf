# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "hcloud_token" {
  description = "Hetzner Cloud API token (analytics project)."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (Zero Trust tunnel + DNS + Access)."
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
  description = "Apex domain (openreplay.<domain> is derived)."
  type        = string
  default     = "alethialabs.io"
}

variable "ssh_public_key" {
  description = "SSH public key authorized on the box."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to SSH in."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "server_type" {
  # OpenReplay's single-node floor is ~4 vCPU / 16 GB. cpx41 = 8 vCPU / 16 GB (AMD) gives headroom
  # for ClickHouse + MinIO + the services. Drop to cpx31 (4 vCPU / 8 GB) only for light/trial use.
  description = "Hetzner server type for the OpenReplay box."
  type        = string
  default     = "cpx41"
}

variable "image" {
  description = "Base OS image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "location" {
  description = "Hetzner location."
  type        = string
  default     = "fsn1"
}

variable "data_volume_size" {
  description = "Data volume size in GB (recordings + events grow here)."
  type        = number
  default     = 100
}

variable "manage_access" {
  # Gate the OpenReplay dashboard behind Cloudflare Zero-Trust Access (team allowlist), bypassing
  # /ingest. Off by default (requires the CF Zero Trust org + access_emails). Until then rely on
  # OpenReplay's own login.
  description = "Whether to manage the Cloudflare Access apps gating the OpenReplay dashboard."
  type        = bool
  default     = false
}

variable "access_emails" {
  description = "Emails allowed into the OpenReplay dashboard via Cloudflare Access."
  type        = list(string)
  default     = []
}
