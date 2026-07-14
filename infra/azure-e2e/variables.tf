# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "subscription_id" {
  description = <<-EOT
    The Azure subscription the e2e nightly provisions into. Azure has NO permissions boundary, so the
    SUBSCRIPTION is the blast-radius boundary: the e2e service principal is granted Contributor +
    User Access Administrator on THIS subscription only. Use a DEDICATED e2e subscription (the Azure
    analogue of a dedicated AWS account) — never a subscription that also holds prod/shared resources.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a GUID."
  }
}

variable "github_repo" {
  description = "owner/repo whose Actions runs may federate into the e2e service principal via OIDC. Bound EXACTLY in the federated credential subject — no wildcard."
  type        = string
  default     = "alethialabs-io/alethialabs"

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repo))
    error_message = "github_repo must be exactly owner/repo."
  }
}

variable "e2e_github_branch" {
  description = "Branch whose Actions runs may federate into the e2e SP. The `schedule` trigger runs on the default branch, so this is `main`. The OIDC `sub` is bound EXACTLY to repo:<repo>:ref:refs/heads/<this> — PRs and other branches cannot federate."
  type        = string
  default     = "main"
}

variable "e2e_github_environment" {
  description = "Optional GitHub Actions environment to ADDITIONALLY trust (adds a second federated credential with subject repo:<repo>:environment:<this>). Empty = ref-only (tightest). Only set if the nightly pins `environment:` AND the environment is branch-restricted to e2e_github_branch."
  type        = string
  default     = ""
}

variable "location" {
  description = "Azure region for the stack's own metadata resources (the budget/action group are subscription-global; this is only where the consumption-budget resource is homed). MUST NOT be named like a prod region."
  type        = string
  default     = "germanywestcentral"

  validation {
    # Defense-in-depth naming guard: refuse an obviously-prod-looking location label.
    condition     = !can(regex("(?i)prod|production|staging", var.location))
    error_message = "location must not be a prod/staging-labelled region."
  }
}

variable "e2e_monthly_budget_usd" {
  description = "Monthly cost ceiling (USD) for the e2e Azure spend. Alerts fire at 50/80/100% actual + 100% forecast. A safety net — the nightly itself is a single tiny ephemeral AKS cluster torn down each run."
  type        = number
  default     = 100

  validation {
    condition     = var.e2e_monthly_budget_usd > 0 && var.e2e_monthly_budget_usd <= 500
    error_message = "e2e_monthly_budget_usd must be 0 < x <= 500."
  }
}

variable "e2e_budget_alert_emails" {
  description = "Email addresses notified by the budget action group + the budget notifications. Empty = action group with no receivers (wire an automation/kill-switch later)."
  type        = list(string)
  default     = []
}

variable "name_prefix" {
  description = "Prefix for the stack's Entra/Azure object names — keeps them grouped + auditable."
  type        = string
  default     = "alethia-e2e"
}
