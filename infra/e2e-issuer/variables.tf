# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "cloudflare_account_id" {
  description = <<-EOT
    The Cloudflare account that owns both the alethialabs.io zone and the alethia-e2e-issuer Worker.
    REQUIRED, with no default: it is not public in this repository, so it is supplied at apply time
    (TF_VAR_cloudflare_account_id, or a gitignored account.auto.tfvars) rather than committed. A
    missing value fails the plan with "No value for required variable" instead of guessing.
    The zone lookup is filtered by this account, so a zone of the same name in another account is
    never matched.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character lowercase hex Cloudflare account id."
  }
}

variable "zone_name" {
  description = <<-EOT
    The Cloudflare zone the issuer host lives in. Committed in terraform.tfvars. The apply token is
    scoped to exactly this zone (README.md), so a different value here would also need a different
    token — which is the point.
  EOT
  type        = string

  validation {
    condition     = var.zone_name == "alethialabs.io"
    error_message = "zone_name must be alethialabs.io — the only zone the issuer may live in and the only zone the apply token is scoped to."
  }
}

variable "hostname" {
  description = <<-EOT
    The host the E2E assertion issuer is served at. `https://<hostname>` IS the issuer: the `iss` of
    every assertion, the discovery document's `issuer`, and the `e2e_broker_issuer_url` four cloud
    trust stacks pin byte-for-byte. Committed in terraform.tfvars; changing it is an issuer
    migration (README.md), not an edit.

    A bare lowercase DNS name: no scheme, no port, no path, no trailing dot. It must NOT sit in
    e2e.alethialabs.io — that name is NS-delegated to Route53 (infra/aws-oidc/e2e-dns.tf), so a
    Cloudflare record under it is shadowed by the delegation and never answers.
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
