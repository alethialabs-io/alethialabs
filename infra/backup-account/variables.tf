# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every input whose default would be a DECISION has no default here: it is either committed in
# terraform.tfvars (public values) or supplied from a gitignored *.auto.tfvars. The same rule as
# infra/aws-e2e and infra/email-ses-account (scripts/check-tfvars-safety.mjs states the reasons).
# The retention numbers are NOT inputs at all: they are constants in main.tf, so changing one is a
# reviewed code change that the posture test reads.

# ── Accounts ───────────────────────────────────────────────────────────────────────────────────────

variable "backup_account_id" {
  description = <<-EOT
    The dedicated `alethia-backup` member account every resource here lands in. The provider refuses
    any other (allowed_account_ids). REQUIRED with no default: the account does not exist until the
    maintainer creates it (README step 1); then commit its id in terraform.tfvars.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.backup_account_id))
    error_message = "backup_account_id must be a 12-digit AWS account id."
  }
}

variable "alethia_account_id" {
  description = "The Alethia platform account (prod vault, deploy roles, tofu state). Named so a precondition can refuse backup_account_id == this: the copies exist to be out of reach of everything that can reach production."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.alethia_account_id))
    error_message = "alethia_account_id must be a 12-digit AWS account id."
  }
}

variable "backup_admin_role_name" {
  description = "The role in the backup account the provider assumes. Created by infra/backup-account/bootstrap (its admin_role_name). The bucket policy names it as one of the principals allowed to administer the bucket."
  type        = string
  default     = "alethia-backup-admin"
}

variable "sso_admin_permission_set" {
  description = <<-EOT
    The IAM Identity Center permission set whose roles in the backup account are its human admins
    (README "Who can delete"). The bucket policy matches
    arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_<this>_* — no other
    Identity Center role, and not the management account's OrganizationAccountAccessRole.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]+$", var.sso_admin_permission_set))
    error_message = "sso_admin_permission_set must be a bare permission-set name such as AdministratorAccess, with no wildcard."
  }
}

variable "backup_region" {
  description = "The region the bucket, key, secret and drill live in. eu-central-1, next to the production vault."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.backup_region))
    error_message = "backup_region must be an AWS region name such as eu-central-1."
  }
}

# ── The box's writer ─────────────────────────────────────────────────────────────────────────────

variable "writer_source_cidrs" {
  description = <<-EOT
    The production box's egress addresses (its IPv4 /32 and IPv6 /64 or /128). Every request the
    backup-writer key makes from anywhere else is denied. REQUIRED, non-empty and NOT committed: the
    box's origin addresses sit behind the Cloudflare tunnel. Put it in the gitignored
    box.auto.tfvars. A re-provisioned box with a new address stops writing backups until this is
    updated — which the daily freshness check reports within 26 hours.
  EOT
  type        = list(string)

  validation {
    condition = length(var.writer_source_cidrs) > 0 && alltrue([
      for c in var.writer_source_cidrs : can(cidrhost(c, 0)) && !endswith(c, "/0")
    ])
    error_message = "writer_source_cidrs must be a non-empty list of valid CIDRs, none of them a /0."
  }
}

variable "backup_prefix" {
  description = "The key prefix backup.sh writes under (BACKUP_PREFIX in deploy/prod/backup/backup.env.example). The writer's grant and the lifecycle rules are both scoped to it."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*$", var.backup_prefix))
    error_message = "backup_prefix must be one lower-case path segment with no slash, such as alethia-prod."
  }
}

# ── GitHub Actions (the freshness monitor and the drill launcher) ───────────────────────────────

variable "github_repo" {
  description = "owner/repo whose workflows may assume backup-reader and drill-launcher."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must be owner/repo."
  }
}

variable "github_branch" {
  description = "The branch whose runs may assume both roles. `schedule` runs on the default branch, so `main`. Bound with StringEquals to repo:<repo>:ref:refs/heads/<this>."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.github_branch)) && !strcontains(var.github_branch, "*")
    error_message = "github_branch must be one concrete branch name, no wildcard."
  }
}

# ── The restore drill ────────────────────────────────────────────────────────────────────────────

variable "drill_instance_type" {
  description = "The drill instance's type: about 4 vCPU and 16 GB, enough to restore Postgres and SeaweedFS and start the console. Launched as spot."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.drill_instance_type))
    error_message = "drill_instance_type must be an EC2 instance type such as m6i.xlarge."
  }
}

variable "drill_max_lifetime_minutes" {
  description = "The instance powers itself off this many minutes after boot, whatever the drill is doing, and powering off terminates it (InstanceInitiatedShutdownBehavior=terminate)."
  type        = number

  validation {
    condition     = var.drill_max_lifetime_minutes >= 30 && var.drill_max_lifetime_minutes <= 360
    error_message = "drill_max_lifetime_minutes must be between 30 and 360."
  }
}

# ── Cost ─────────────────────────────────────────────────────────────────────────────────────────

variable "monthly_budget_usd" {
  description = "The account's monthly cost budget in USD. The expected spend is about USD 3–5 (README \"Cost\"), so a breach means a leaked drill instance or runaway storage."
  type        = number

  validation {
    condition     = var.monthly_budget_usd >= 1 && var.monthly_budget_usd <= 100
    error_message = "monthly_budget_usd must be between 1 and 100."
  }
}

variable "budget_alert_emails" {
  description = "Inboxes the budget notifies. REQUIRED with no default (personal addresses, public repo): set it in the gitignored emails.auto.tfvars. At least one: a budget nobody hears is no alarm."
  type        = list(string)

  validation {
    condition     = length(var.budget_alert_emails) > 0 && alltrue([for e in var.budget_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "budget_alert_emails must be a non-empty list of email addresses."
  }
}
