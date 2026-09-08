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
  # used when manage_email_routing = true. The live routing was bootstrapped out-of-band and is
  # absent from this stack's state, so it stays "" and the routing resources are gated off. It
  # is set in the SAME change as the import, never before and never after — see
  # manage_email_routing's description for why either order alone breaks something, and #4374
  # for the adoption itself.
  description = "Inbox that inbound alethialabs.io mail is forwarded to (when manage_email_routing)."
  type        = string
  default     = ""
}

variable "manage_email_routing" {
  description = <<-EOT
    Whether Terraform manages the 11 Cloudflare Email Routing resources in email-routing.tf —
    the zone settings, the destination address, 8 inbound forward rules, and the catch-all.

    `false`, and DELIBERATELY DORMANT rather than pending (#3291). The routing was bootstrapped
    out-of-band and is live; NONE of it is in this stack's OpenTofu state. So the gate is not a
    feature flag waiting to be flipped — it is the statement that these declarations describe
    objects Terraform does not own. Adopting them is #4374, and is not done by setting this input.

    THE HAZARD IS THE TRANSITION, AND IT IS REAL RATHER THAN THEORETICAL. Import any of these into
    state — or create them from a local apply — while this input is still unset, and the
    configuration gates the resource to zero instances while state holds one. That is a planned
    DESTROY of live inbound mail, and .github/workflows/infra-cp-hetzner.yml applies it
    `-auto-approve`, unattended, on the next push to `main` that touches `infra/cp-hetzner/**`
    (the workflow's own `paths:` filter — not every push to main, but every push that edits this
    stack, which includes the push that would carry the import). The eight local-parts are the
    addresses printed in transactional email footers and on the contact, CLA, legal and security
    pages, so the blast radius is inbound mail to the company.

    Setting it true FIRST fails the other way: the objects already exist in Cloudflare, so create
    collides ("already exists") and takes the box provision down with it. Neither order is safe on
    its own — import and input have to land together, which is why #4374 is one unit and why this
    is written here rather than left to whoever runs the import to rediscover.

    WHAT ENFORCES THIS, precisely. The dormancy is enforced: `count`/`for_each` in email-routing.tf
    read this variable, its default is false, this stack has no committed terraform.tfvars, and the
    apply workflow loads exactly five TF_VAR_* from Secrets Manager — none of them this one. What is
    NOT enforced is the transition above: no check, guard or CI job notices an import landing
    without the input. This paragraph is the only thing standing between that import and the
    destroy, which is the reason it is this long.
  EOT
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
  # Open by DECISION, recorded in infra/tfvars-safety-baseline.json (#3292 point 2) rather than
  # deferred. SSH from a GitHub-hosted runner is a live, required path into this box, not a
  # hypothetical one: deploy-console.yml SSHes to `root@$DEPLOY_HOST` (:1052, :1059, :1173) and
  # DEPLOY_HOST is this server's IP, chained into Secrets Manager by infra-cp-hetzner.yml. Runner
  # egress ranges are published but large and they move, so pinning them breaks the only path
  # console code has to production on a day nobody changed anything.
  #
  # "Key-only auth" is the usual next sentence, so: nothing in this repo enforces it. No cloud-init
  # here writes an sshd_config or sets PasswordAuthentication, and no test asserts it — it holds
  # because the image ships with no root password. It is an inherited property and a mitigation,
  # not the control this variable is named after. A bastion/Tailscale hop would be narrower AND
  # enforced; that is the harden-later path.
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
