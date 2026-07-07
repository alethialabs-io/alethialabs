# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "location" {
  description = "Azure region."
  type        = string
  default     = "westeurope"
}

variable "resource_group_name" {
  description = "Resource group to create."
  type        = string
  default     = "alethia-cp"
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

variable "ssh_public_key" {
  description = "SSH public key set on the VM (for Serial Console break-glass; never network-reachable)."
  type        = string
}

variable "admin_username" {
  description = "Linux admin user."
  type        = string
  default     = "alethia"
}

variable "vm_size" {
  # x86 Gen2 (Trusted-Launch capable), matches the amd64 self-host images. D2s_v5 = 2 vCPU / 8 GB,
  # the cheapest general-purpose tier with headroom for the compose bundle plus a TF run.
  description = "Azure VM size (x86 Gen2, Trusted-Launch capable)."
  type        = string
  default     = "Standard_D2s_v5"
}

variable "os_disk_size" {
  description = "OS disk size (GB) — holds Docker data (Postgres + object store)."
  type        = number
  default     = 30
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
