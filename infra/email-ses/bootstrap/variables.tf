# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "AWS region the SES stack lives in (matches the main stack)."
  type        = string
  default     = "eu-central-1"
}

variable "domain" {
  description = "Root domain — sending subdomains hang off this (for the send policy ARNs)."
  type        = string
  default     = "alethialabs.io"
}

# Must match the main stack's `streams` keys/subdomains so the constructed
# identity + configuration-set ARNs line up.
variable "streams" {
  description = "Sending streams → subdomain (relative to var.domain)."
  type = map(object({
    subdomain = string
  }))
  default = {
    auth    = { subdomain = "auth" }
    general = { subdomain = "mail" }
  }
}

variable "sender_user_name" {
  description = "Existing runtime IAM user the scoped send policy is attached to."
  type        = string
  default     = "alethia-ses-sender"
}

variable "state_bucket_name" {
  description = "S3 bucket holding OpenTofu state for the SES stacks (this account)."
  type        = string
  default     = "alethia-tofu-state-270587882865"
}

# ── GitHub OIDC ──────────────────────────────────────────────────────────────

variable "create_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. Set false to adopt an existing one via oidc_provider_arn."
  type        = bool
  default     = true
}

variable "oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider (used only when create_oidc_provider = false)."
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "owner/repo allowed to assume the deploy role via OIDC."
  type        = string
  default     = "bobikenobi12/bb-thesis-2026"
}

variable "github_branch" {
  description = "Branch whose Actions runs may assume the deploy role (the apply branch)."
  type        = string
  default     = "main"
}

variable "admin_principal_arns" {
  description = "Extra IAM principals allowed to assume the deploy role (e.g. an admin user/role for local import/apply). Empty = OIDC only."
  type        = list(string)
  default     = []
}
