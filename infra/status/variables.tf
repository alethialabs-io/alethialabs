# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "hcloud_token" {
  description = "Hetzner Cloud API token."
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key authorized on the server."
  type        = string
}

variable "domain" {
  description = "Apex domain. The status page is served at status.<domain>."
  type        = string
  default     = "alethialabs.io"
}

variable "acme_email" {
  description = "Email for Let's Encrypt (Caddy ACME registration)."
  type        = string
}

variable "server_type" {
  # CAX11 = Ampere ARM64, 2 vCPU / 4 GB — far more than Gatus + Caddy need. This
  # box runs ONLY the status page (no app, no runner), so the smallest ARM tier is
  # the right cheapest-viable footprint (~EUR 4/mo).
  description = "Hetzner server type."
  type        = string
  default     = "cax11"
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

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to reach SSH (22)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia (for deploy/status)."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
