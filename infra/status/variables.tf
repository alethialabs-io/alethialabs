# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "cloudflare_account_id" {
  description = <<-EOT
    The Cloudflare account that owns the alethialabs.io zone and will own the Worker, D1 and KV.
    REQUIRED, with no default: it is not public in this repository, so it is supplied at apply time
    (TF_VAR_cloudflare_account_id, or a gitignored account.auto.tfvars) rather than committed.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hex Cloudflare account id."
  }
}

variable "zone_name" {
  description = "The Cloudflare zone the status host lives in. Committed in terraform.tfvars."
  type        = string

  validation {
    condition     = var.zone_name == "alethialabs.io"
    error_message = "zone_name must be alethialabs.io."
  }
}

variable "hostname" {
  description = <<-EOT
    The host the page is served at. Committed in terraform.tfvars. It has a second copy that must
    agree with it: SITE in packages/status/src/render.ts, which builds every link the page emits.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.hostname))
    error_message = "hostname must be a bare lowercase DNS name — no scheme, port, path or trailing dot."
  }
}

variable "worker_bundle_path" {
  description = <<-EOT
    Path to the BUILT Worker bundle (one ES module), relative to this directory. OpenTofu cannot bundle
    TypeScript, so `pnpm -F @repo/status build` writes it first; the script's precondition fails the
    plan when it is missing or empty rather than letting an empty script reach Cloudflare.
  EOT
  type        = string
  default     = "../../packages/status/dist/worker.js"
}

variable "status_probe_token" {
  description = <<-EOT
    The bearer the Worker presents to the console's /api/health. It must equal ALETHIA_STATUS_PROBE_TOKEN
    in alethia/prod/env — read it from there at apply time (TF_VAR_status_probe_token), never type a new
    one here. REQUIRED, no default: without it the Database and Authorization rows can only read
    "degraded". It is written to this stack's state, which is why the backend encrypts.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.status_probe_token) >= 32
    error_message = "status_probe_token must be at least 32 characters (openssl rand -hex 32)."
  }
}
