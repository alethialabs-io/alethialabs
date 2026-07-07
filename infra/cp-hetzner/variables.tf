# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Zero Trust tunnel."
  type        = string
}

variable "domain" {
  description = "Apex domain served by the control plane."
  type        = string
  default     = "alethialabs.io"
}

variable "email_forward_to" {
  # Destination inbox for Cloudflare Email Routing (infra/cp-hetzner/email-routing.tf) — only
  # used when manage_email_routing = true. The live routing was bootstrapped out-of-band (the
  # cp-hetzner state is empty), so it stays "" and the routing resources are gated off until
  # the existing routing is `tofu import`-ed post-launch (see README). Set the real inbox in
  # the gitignored terraform.tfvars / CI when flipping manage_email_routing on.
  description = "Inbox that inbound alethialabs.io mail is forwarded to (when manage_email_routing)."
  type        = string
  default     = ""
}

variable "manage_email_routing" {
  # false (default): Terraform does NOT manage the Cloudflare Email Routing resources. They were
  # bootstrapped out-of-band and are live; the cp-hetzner state is empty, so a fresh apply would
  # collide ("already exists") and fail the box provision. Flip true only AFTER `tofu import`-ing
  # the existing settings/address/rules/catch-all into state (see README).
  description = "Whether Terraform manages the Cloudflare Email Routing resources in email-routing.tf."
  type        = bool
  default     = false
}

variable "ssh_public_key" {
  description = "SSH public key authorized on the server (CI deploy key)."
  type        = string
}

variable "server_type" {
  # CX33 = Intel x86 (4 vCPU / 8 GB) — the box images build linux/amd64 to match.
  # We moved off CAX (Ampere ARM64) because Hetzner ARM capacity in fsn1 is chronically
  # out (resource_unavailable); the Intel CX line is abundant. Enough headroom to run
  # the compose bundle plus an OpenTofu job; bump to cx43 if it gets busy. (The runner
  # FLEET stays ARM/CAX — its images are still built arm64.)
  description = "Hetzner server type."
  type        = string
  default     = "cx33"
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
  # replacement on `tofu apply`.
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

variable "environment" {
  description = "Deployment environment tag (FinOps) — Dev, Stage, or Prod."
  type        = string
  default     = "Prod"
  validation {
    condition     = contains(["Dev", "Stage", "Prod"], var.environment)
    error_message = "environment must be Dev, Stage, or Prod."
  }
}
