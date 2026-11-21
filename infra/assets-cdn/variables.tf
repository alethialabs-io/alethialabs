# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "cloudflare_account_id" {
  description = <<-EOT
    The Cloudflare account that owns the alethialabs.io zone and will own the bucket.
    REQUIRED, with no default: it is not public in this repository, so it is supplied at apply time
    (TF_VAR_cloudflare_account_id, or a gitignored account.auto.tfvars) rather than committed. A
    missing value fails the plan with "No value for required variable" instead of guessing.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hex Cloudflare account id."
  }
}

variable "zone_name" {
  description = "The Cloudflare zone the assets host lives in. Committed in terraform.tfvars."
  type        = string

  validation {
    condition     = var.zone_name == "alethialabs.io"
    error_message = "zone_name must be alethialabs.io — the only zone this stack serves from."
  }
}

variable "hostname" {
  description = <<-EOT
    The public host every app links media from. Committed in terraform.tfvars. Changing it breaks every
    URL already published (emails, the News feed, link previews), so it is a migration, not an edit.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.hostname))
    error_message = "hostname must be a bare lowercase DNS name — no scheme, port, path or trailing dot."
  }

  validation {
    condition     = var.hostname != "e2e.alethialabs.io" && !endswith(var.hostname, ".e2e.alethialabs.io")
    error_message = "hostname must not be in e2e.alethialabs.io: that subzone is delegated to Route53, so Cloudflare cannot serve it."
  }
}

variable "bucket_name" {
  description = <<-EOT
    The R2 bucket's name. Committed in terraform.tfvars. R2 names are permanent: a rename is a new
    bucket plus a copy, and the old one is protected by prevent_destroy (main.tf).
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3–63 characters of lowercase letters, digits and hyphens, not starting or ending with a hyphen."
  }
}

variable "cors_origins" {
  description = <<-EOT
    The origins allowed to read objects cross-origin (fonts, fetch(), <video crossorigin>). Committed
    in terraform.tfvars. A plain <img> or <video> needs no CORS at all; this list only matters to code
    that reads the bytes. Each entry is a bare https origin.
  EOT
  type        = list(string)

  validation {
    condition     = length(var.cors_origins) > 0 && alltrue([for o in var.cors_origins : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "cors_origins must be a non-empty list of bare https origins (no path, no trailing slash, no wildcard)."
  }
}

variable "manage_cache_rule" {
  description = <<-EOT
    Whether this stack owns the zone's cache-settings ruleset (phase http_request_cache_settings).
    REQUIRED and committed in terraform.tfvars, never defaulted: a zone holds exactly ONE ruleset per
    phase, so creating it here takes over any cache rule made in the dashboard. Set true only after the
    zone's Caching → Cache Rules page is empty (README.md, step 1). False is safe too: objects uploaded
    with the Cache-Control the README prescribes are cached at the edge without any rule.
  EOT
  type        = bool
}
