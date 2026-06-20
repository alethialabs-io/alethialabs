# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "location" {
  # Must offer Ampere ARM (Dpsv5) VMs — e.g. westeurope, northeurope, eastus.
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
  description = "SSH public key authorized on the VM (CI deploy key)."
  type        = string
}

variable "admin_username" {
  description = "Linux admin user."
  type        = string
  default     = "alethia"
}

variable "vm_size" {
  # Dpsv5 = Ampere Altra ARM64 (matches the arm64 images). D2ps_v5 = 2 vCPU / 8 GB.
  description = "Azure VM size (must be ARM/Dpsv5)."
  type        = string
  default     = "Standard_D2ps_v5"
}

variable "os_disk_size" {
  description = "OS disk size (GB) — holds Docker data (Postgres + object store)."
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
