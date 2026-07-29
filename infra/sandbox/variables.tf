# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "hcloud_token" {
  description = "Hetzner Cloud API token for the sandbox project."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS edit + Zero Trust tunnel write on the zone."
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
  description = "Apex domain. Envs are served under <slug>.<env_subdomain>.<domain>."
  type        = string
  default     = "alethialabs.io"
}

variable "env_subdomain" {
  # The wildcard lives one level down (*.dev.<domain>) so a branch env can never
  # collide with a real product hostname, and so the single wildcard record covers
  # every future branch without a dashboard visit.
  description = "Subdomain under which branch environments are served."
  type        = string
  default     = "dev"
}

variable "ssh_public_key" {
  description = "SSH public key authorized on the box (your laptop's key)."
  type        = string
}

variable "ssh_allowed_cidrs" {
  # Unlike cp-hetzner (which must accept dynamic GitHub-runner egress), this box is
  # only ever reached from one laptop, so it CAN be locked down. Default is open to
  # keep a first apply from locking you out; narrow it in terraform.tfvars.
  description = "CIDRs allowed to reach SSH (22). Narrow this to your own IP."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "server_type" {
  # WHY x86 AND NOT ARM, despite ARM being ~3x cheaper (cax31 EUR 20.99 vs cpx42
  # EUR 69.49):
  #
  #   1. ARM IS OUT OF STOCK IN EU. Checked 2026-07-27: nbg1/hel1/fsn1 list ZERO cax
  #      types as available; the same scarcity is already documented in
  #      infra/cp-hetzner/variables.tf ("we moved off CAX because Hetzner ARM capacity
  #      is chronically out"). A cax31 apply fails with `resource_unavailable`.
  #   2. IT INTERACTS BADLY WITH REAPING. This box is snapshot-and-deleted when idle,
  #      and a Hetzner snapshot is ARCHITECTURE-BOUND — an ARM snapshot only restores
  #      onto an ARM server. So an ARM box reaped during a capacity crunch cannot be
  #      restored at all until stock returns. x86 has no such cliff.
  #   3. x86 MATCHES THE FLEET. The runner fleet ships linux/amd64 images; an ARM box
  #      builds arm64, which is exactly the mismatch behind the ~100-VM/8h churn
  #      incident. On x86 the box can build fleet-accurate images.
  #
  # Because reaping bills hourly, the sticker price is not what you pay: cpx42 at a
  # realistic 8h x 22d is ~EUR 19.61/mo — under an always-on cax31.
  #
  # Sized for the measured footprint: ~0.5 GB shared tier + ~2 GB per `next dev` +
  # ~1 GB for a warm Go build => 16 GB holds the cap of 3 envs. To go cheaper at 2
  # envs use cpx32 (4c/8GB, EUR 35.49). To try ARM once stock returns, set cax31 —
  # `pnpm env:up` preflights capacity and names alternatives before tofu runs.
  # cpx32 (4c/8GB/160GB). Sized for COST, because billing is hourly and the box is
  # deleted when idle: EUR 0.0569/h is ~EUR 7.51/mo at 6h x 22d, against EUR 14.70 for
  # cpx42. It still fits the shared tier (~1GB) + two envs (~2-3GB each) + a Chromium run.
  #
  # ⚠ CHANGING THIS DOWNWARD CANNOT USE A SNAPSHOT. Hetzner refuses to restore a snapshot
  # onto a smaller disk, so a cpx42 (320GB) snapshot will not boot a cpx32 (160GB). Going
  # down means letting the box go and building fresh; going up is fine.
  description = "Hetzner server type for the sandbox box."
  type        = string
  default     = "cpx32"
}

variable "location" {
  description = "Hetzner location (fsn1/nbg1/hel1 are EU)."
  type        = string
  default     = "nbg1"
}

variable "image" {
  # Ignored when restoring: env:up passes the snapshot id as `image` so a reaped box
  # comes back with its databases and node_modules intact.
  description = "Base OS image, or a snapshot ID when restoring a reaped box."
  type        = string
  default     = "ubuntu-24.04"
}

variable "env_cap" {
  # A memory budget, not a policy: at ~2 GB per `next dev` on a 16 GB box, the fourth
  # environment is the one that starts swapping and turns every timing assertion into
  # a coin flip. Surfaced here so resizing the box and the cap stay one decision.
  # Delivered to the box by `env:up` (provision_box writes /opt/alethia/box.env), NOT
  # by re-running cloud-init — user_data is ignored after creation because changing it
  # would replace the server. So raising this takes effect on the next env:up.
  description = "Maximum concurrent branch environments the box will allocate."
  type        = number
  default     = 4
  validation {
    condition     = var.env_cap >= 1 && var.env_cap <= 6
    error_message = "env_cap must be between 1 and 6 (the port pools are sized for 6)."
  }
}

variable "environment" {
  description = "Deployment environment tag (FinOps) — Dev, Stage, or Prod."
  type        = string
  default     = "Dev"
  validation {
    condition     = contains(["Dev", "Stage", "Prod"], var.environment)
    error_message = "environment must be Dev, Stage, or Prod."
  }
}
