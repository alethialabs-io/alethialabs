# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "AWS region (matches the main stack — its segment of the public asset URL)."
  type        = string
  default     = "eu-west-1"
}

variable "bucket_name" {
  description = "The connector-assets bucket the deploy role is scoped to (must match the main stack)."
  type        = string
  default     = "alethia-connector-assets"
}

variable "state_bucket_name" {
  description = "Existing S3 bucket holding OpenTofu state for this account's stacks (created by infra/email-ses/bootstrap)."
  type        = string
  default     = "alethia-tofu-state-270587882865"
}

# ── GitHub OIDC ──────────────────────────────────────────────────────────────

variable "create_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. Default false: adopt the existing one (the SES bootstrap created it) via oidc_provider_arn."
  type        = bool
  default     = false
}

variable "oidc_provider_arn" {
  description = "ARN of the existing GitHub OIDC provider (used when create_oidc_provider = false). e.g. arn:aws:iam::270587882865:oidc-provider/token.actions.githubusercontent.com"
  type        = string
  default     = "arn:aws:iam::270587882865:oidc-provider/token.actions.githubusercontent.com"
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
