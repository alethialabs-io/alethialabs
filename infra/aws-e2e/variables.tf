# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every input whose default would be a DECISION has no default here: it is either committed in
# terraform.tfvars (public values) or supplied from the gitignored emails.auto.tfvars. infra/aws-oidc
# learned this the hard way — an empty-defaulting zone name planned the destruction of a delegated
# zone, an empty environment narrowed the trust, and a default budget doubled the live ceiling.

# ── Accounts ───────────────────────────────────────────────────────────────────────────────────────

variable "e2e_account_id" {
  description = "The dedicated `alethia-e2e` member account every resource here lands in. The provider refuses any other (allowed_account_ids)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.e2e_account_id))
    error_message = "e2e_account_id must be a 12-digit AWS account id."
  }
}

variable "alethia_account_id" {
  description = "The Alethia platform account (prod state bucket, prod vault, ECR, SES). Named so the boundary can deny its prod resources by ARN and so a precondition can refuse e2e_account_id == this."
  type        = string
  default     = "270587882865"

  validation {
    condition     = can(regex("^[0-9]{12}$", var.alethia_account_id))
    error_message = "alethia_account_id must be a 12-digit AWS account id."
  }
}

variable "e2e_admin_role_name" {
  description = "The role in the e2e account the provider assumes. Created by infra/aws-e2e/bootstrap (its admin_role_name)."
  type        = string
  default     = "alethia-e2e-admin"
}

variable "state_bucket_name" {
  description = "The Alethia platform account's OpenTofu state bucket. The e2e role holds no grant on it (it is in another account), and the boundary also denies it by name as defence in depth."
  type        = string
  default     = "alethia-tofu-state-270587882865"
}

variable "prod_env_secret_name" {
  description = "The prod secret vault's name in the Alethia platform account, denied by ARN in the boundary as defence in depth."
  type        = string
  default     = "alethia/prod/env"
}

# ── GitHub OIDC trust (same subjects as infra/aws-oidc's e2e-nightly role) ─────────────────────────

variable "github_repo" {
  description = "owner/repo whose Actions runs may assume the e2e role."
  type        = string
  default     = "alethialabs-io/alethialabs"
}

variable "e2e_github_branch" {
  description = "Branch whose runs may assume the role by REF. `schedule` runs on the default branch, so `main`. Bound with StringEquals to `repo:<repo>:ref:refs/heads/<this>`."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[A-Za-z0-9_./-]+$", var.e2e_github_branch)) && !strcontains(var.e2e_github_branch, "*")
    error_message = "e2e_github_branch must be a plain branch name with no wildcard."
  }
}

variable "e2e_github_environment" {
  description = "GitHub environment ALSO trusted (exact `repo:<repo>:environment:<this>`). The nightly job pins `environment: e2e-dev`, branch-restricted to `dev`; without it no dispatch from dev federates. Required, and committed in terraform.tfvars: an empty value used to narrow the trust to ref-only in silence."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+$", var.e2e_github_environment))
    error_message = "e2e_github_environment must be a plain environment name (no '*', ':' or spaces) - it is interpolated into an exact OIDC subject."
  }
}

variable "spend_reporter_environment" {
  description = "GitHub Actions environment the weekly spend report job (spend-report.yml) selects. This account's alethia-spend-reporter trusts the exact `repo:<repo>:environment:<this>` sub and nothing else — the same subject as infra/aws-oidc's reporter. The environment is restricted to `main` (infra/github/environments.tf). Required, and committed in terraform.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+$", var.spend_reporter_environment))
    error_message = "spend_reporter_environment must be a plain environment name (no '*', ':' or spaces) - it is interpolated into an exact OIDC subject."
  }
}

# ── Region lock ───────────────────────────────────────────────────────────────────────────────────

variable "e2e_region" {
  description = "The single region the e2e role may operate in (hard-denied everywhere else). Kept identical to infra/aws-oidc's so the harness, the cleanup and the reaper need no change."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = !contains(["eu-central-1", "eu-west-1"], var.e2e_region)
    error_message = "e2e_region must not be a prod region (eu-central-1 hosts state/SES, eu-west-1 hosts the runner fleet)."
  }
}

# ── Cost guard ────────────────────────────────────────────────────────────────────────────────────

variable "e2e_monthly_budget_usd" {
  description = "Monthly cost ceiling (USD) for the WHOLE e2e account. Alerts at 50/80/100% actual + 100% forecast. Required and committed in terraform.tfvars (a default once silently doubled the live ceiling)."
  type        = number

  validation {
    condition     = var.e2e_monthly_budget_usd > 0 && var.e2e_monthly_budget_usd <= 500
    error_message = "e2e_monthly_budget_usd must be in (0, 500]."
  }
}

variable "e2e_budget_alert_emails" {
  description = "Email addresses for the budget (direct + SNS). Required with no default, and the one input that cannot be committed (personal addresses, public repo): supply it in the gitignored emails.auto.tfvars. Pass [] explicitly to opt out."
  type        = list(string)
}

# ── DNS ───────────────────────────────────────────────────────────────────────────────────────────

variable "e2e_dns_zone_name" {
  description = "Public zone the T2 ACM/cert proof validates against, e.g. e2e.alethialabs.io. A SECOND zone of the same name as infra/aws-oidc's: Route 53 allows that across accounts, and which one answers is decided by the NS set at Cloudflare. Required."
  type        = string

  validation {
    # Refuse an apex: delegating alethialabs.io itself into the e2e account would move production DNS.
    condition     = length(split(".", trimsuffix(var.e2e_dns_zone_name, "."))) >= 3
    error_message = "e2e_dns_zone_name must be a SUBDOMAIN (e.g. e2e.alethialabs.io), never an apex."
  }
}

variable "e2e_dns_ns_ttl" {
  description = "TTL of the zone's own apex NS record. Route 53 creates it at 172800 (48h), which is how long a resolver keeps asking THIS zone after a re-delegation — so a rollback at Cloudflare would take two days to land. 300 makes a cutover and a rollback take minutes."
  type        = number
  default     = 300

  validation {
    condition     = var.e2e_dns_ns_ttl >= 60 && var.e2e_dns_ns_ttl <= 172800
    error_message = "e2e_dns_ns_ttl must be between 60 and 172800 seconds."
  }
}

# ── E2E assertion broker (#4226) ───────────────────────────────────────────────────────────────────

variable "e2e_broker_issuer_url" {
  description = <<-EOT
    The HTTPS origin of the E2E assertion broker (apps/e2e-issuer), identical to infra/aws-oidc's
    variable of the same name and checked against it by scripts/ci/check-e2e-issuer-health.mjs. The
    committed terraform.tfvars sets it; null creates no broker trust. A bare lowercase origin only (no
    path, port or trailing slash). To plan without the broker pass
    -var-file=<(printf 'e2e_broker_issuer_url = null\n').
  EOT
  type        = string
  default     = null

  validation {
    condition = var.e2e_broker_issuer_url == null || (
      can(regex("^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.e2e_broker_issuer_url)) &&
      var.e2e_broker_issuer_url != "https://token.actions.githubusercontent.com"
    )
    error_message = "e2e_broker_issuer_url must be null or a bare lowercase https origin (no path, port or trailing slash) that is not the GitHub Actions issuer."
  }
}
