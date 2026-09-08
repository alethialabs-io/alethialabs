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
  description = <<-EOT
    CIDRs allowed to reach SSH (22). Read straight into the `source_ips` of the port-22 rule on the
    `alethia-status` firewall (main.tf:29) — this value IS the allowlist that gets applied.

    REQUIRED, with no default (#3292). It defaulted to ["0.0.0.0/0", "::/0"] with nothing narrowing
    it, and — unlike infra/cp-hetzner and infra/sandbox, which each record a reason for theirs —
    with no reason recorded anywhere. Nobody chose the open value here; it is what an unfilled
    declaration left behind, and it was therefore the box's live SSH allowlist.

    WHY REQUIRED RATHER THAN NARROWED IN CODE. No correct narrow value could be established from
    this repository without inventing one. Nothing in CI reaches this box over SSH: the only
    workflow that SSHes anywhere is deploy-console.yml, and it dials DEPLOY_HOST, which is the
    cp-hetzner control-plane box. This one is built entirely by cloud-init at first boot (clone the
    repo, `docker compose up`) and is never touched again by automation. SSH here is a human path
    from an address this repo does not record — and a guessed CIDR on a box nobody watches applying
    is how the maintainer gets locked out of it.

    WHAT REQUIRED ENFORCES: OpenTofu exits 1 with "No value for required variable" when nothing
    supplies it, so the open allowlist can no longer be reached by leaving a line out. That is the
    whole mechanism. ["0.0.0.0/0", "::/0"] is still a legal value — the `ssh_allowlist_is_narrow`
    check in main.tf reports it on every plan, but a `check` block emits a WARNING and does not
    fail an apply. Nothing here verifies that a narrow value is the RIGHT one either.

    Supply it as a gitignored terraform.tfvars, `-var`, or TF_VAR_ssh_allowed_cidrs — the apply
    workflow reads the STATUS_SSH_ALLOWED_CIDRS repository variable into that env var.
  EOT
  type        = list(string)
}

variable "repo_url" {
  description = "Git repo cloned onto the box at /opt/alethia (for deploy/status)."
  type        = string
  default     = "https://github.com/alethialabs-io/alethialabs.git"
}
