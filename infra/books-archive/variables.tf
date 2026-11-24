# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every input whose default would be a DECISION has no default here: it is either committed in
# terraform.tfvars (public values) or supplied from a gitignored *.auto.tfvars. The same rule as
# infra/backup-account (scripts/check-tfvars-safety.mjs states the reasons). The retention numbers
# are NOT inputs at all: they are constants in main.tf.

# ── Accounts ───────────────────────────────────────────────────────────────────────────────────────

variable "backup_account_id" {
  description = "The existing `alethia-backup` member account every resource here lands in (infra/backup-account/terraform.tfvars). The provider refuses any other (allowed_account_ids)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.backup_account_id))
    error_message = "backup_account_id must be a 12-digit AWS account id."
  }
}

variable "alethia_account_id" {
  description = "The Alethia platform account (prod vault, deploy roles, tofu state). Named so a precondition can refuse backup_account_id == this: the archive must be out of reach of everything that can reach production."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.alethia_account_id))
    error_message = "alethia_account_id must be a 12-digit AWS account id."
  }
}

variable "backup_admin_role_name" {
  description = "The role in the backup account the provider assumes. Created by infra/backup-account/bootstrap. The bucket, key and secret policies name it as an administering principal."
  type        = string
  default     = "alethia-backup-admin"
}

variable "sso_admin_permission_set" {
  description = <<-EOT
    The IAM Identity Center permission set whose roles in the backup account are its human admins.
    The bucket, key and secret policies match
    arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_<this>_*.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]+$", var.sso_admin_permission_set))
    error_message = "sso_admin_permission_set must be a bare permission-set name such as AdministratorAccess, with no wildcard."
  }
}

variable "region" {
  description = "The region the bucket, key and secret live in. eu-central-1, beside the backup bucket and the production vault."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.region))
    error_message = "region must be an AWS region name such as eu-central-1."
  }
}

# ── The books workflow (GitHub OIDC) ────────────────────────────────────────────────────────────

variable "books_github_repo" {
  description = "owner/repo of the private books repository whose workflow assumes books-monthly."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.books_github_repo))
    error_message = "books_github_repo must be owner/repo."
  }
}

variable "books_github_environment" {
  description = "The GitHub environment whose jobs may assume books-monthly. Bound with StringEquals to repo:<repo>:environment:<this>; the environment's own protection (main only) is what restricts which refs reach it."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.books_github_environment))
    error_message = "books_github_environment must be one concrete environment name, no wildcard or slash."
  }
}

# ── The console's writer ─────────────────────────────────────────────────────────────────────────

variable "console_writer_source_cidrs" {
  description = <<-EOT
    The production box's egress addresses (its IPv4 /32 and IPv6 /64 or /128). Every request the
    console-books-writer key makes from anywhere else is denied. REQUIRED, non-empty and NOT
    committed: the box's origin addresses sit behind the Cloudflare tunnel and are published nowhere
    in this repo. Put them in the gitignored box.auto.tfvars — the same values as
    infra/backup-account/box.auto.tfvars (writer_source_cidrs).
  EOT
  type        = list(string)

  validation {
    condition = length(var.console_writer_source_cidrs) > 0 && alltrue([
      for c in var.console_writer_source_cidrs : can(cidrhost(c, 0)) && !endswith(c, "/0")
    ])
    error_message = "console_writer_source_cidrs must be a non-empty list of valid CIDRs, none of them a /0."
  }
}

# ── Cost ─────────────────────────────────────────────────────────────────────────────────────────

variable "monthly_budget_usd" {
  description = "This stack's monthly cost budget in USD. Expected spend is about USD 1.5 (README \"Cost\")."
  type        = number

  validation {
    condition     = var.monthly_budget_usd >= 1 && var.monthly_budget_usd <= 100
    error_message = "monthly_budget_usd must be between 1 and 100."
  }
}

variable "budget_alert_emails" {
  description = "Inboxes the budget notifies. REQUIRED with no default (personal addresses, public repo): set it in the gitignored emails.auto.tfvars."
  type        = list(string)

  validation {
    condition     = length(var.budget_alert_emails) > 0 && alltrue([for e in var.budget_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "budget_alert_emails must be a non-empty list of email addresses."
  }
}
