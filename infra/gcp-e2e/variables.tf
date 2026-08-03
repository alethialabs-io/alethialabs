# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ── The dedicated e2e GCP project ────────────────────────────────────────────
variable "project_id" {
  description = "The DEDICATED GCP project the e2e nightly provisions into. MUST be a throwaway e2e project — never a prod/shared project (the WIF SA gets broad container/compute/… admin here)."
  type        = string
}

variable "region" {
  description = "The region the e2e nightly provisions in (also the provider default). Validated to never be a prod region so a stray run can't touch prod estate."
  type        = string
  default     = "europe-west3"

  validation {
    # eu-central-1 has no GCP analogue; the Alethia prod estate that matters here is the fleet /
    # control-plane. Keep the e2e project's region off any region a prod GCP workload could use.
    condition     = !contains(["us-central1", "us-east1"], var.region)
    error_message = "region must not be a prod-adjacent region (us-central1 / us-east1) — the e2e project is isolated; pick a dedicated region such as europe-west3."
  }
}

# ── GitHub OIDC scoping (parameterized — owner/repo/branch can change without edits) ──
variable "github_repo" {
  description = "owner/repo whose Actions runs may federate into the e2e SA via WIF. The provider's attribute CONDITION pins this exactly (StringEquals-equivalent)."
  type        = string
  default     = "alethialabs-io/alethialabs"
}

variable "e2e_github_ref" {
  description = "The git ref (refs/heads/<branch>) whose Actions runs may assume the e2e SA. The `schedule` trigger runs on the default branch, so this is refs/heads/main. The provider's attribute condition pins BOTH repo AND ref exactly — PRs, forks, and sibling branches cannot federate."
  type        = string
  default     = "refs/heads/main"

  validation {
    condition     = startswith(var.e2e_github_ref, "refs/") && !strcontains(var.e2e_github_ref, "*")
    error_message = "e2e_github_ref must be a concrete git ref (refs/heads/<branch> or refs/tags/<tag>) with no '*' wildcard."
  }
}

# ── WIF identifiers ──────────────────────────────────────────────────────────
variable "pool_id" {
  description = "Workload Identity Pool ID for the e2e GitHub federation."
  type        = string
  default     = "alethia-e2e-gh-pool"
}

variable "provider_id" {
  description = "Workload Identity Pool Provider ID (the GitHub OIDC provider)."
  type        = string
  default     = "alethia-e2e-gh-provider"
}

variable "service_account_id" {
  description = "Account ID (local part) of the e2e provisioner service account."
  type        = string
  default     = "alethia-e2e-nightly"
}

variable "github_oidc_issuer" {
  description = "GitHub Actions OIDC issuer URL (the trust root)."
  type        = string
  default     = "https://token.actions.githubusercontent.com"
}

# ── Cost guard ───────────────────────────────────────────────────────────────
variable "billing_account_id" {
  description = "The billing account the e2e project is linked to (needed to create the budget). Format XXXXXX-XXXXXX-XXXXXX."
  type        = string
}

variable "e2e_monthly_budget_usd" {
  description = "Monthly cost ceiling (USD) for the e2e GCP spend. Alerts fire at 50/80/100% actual + 100% forecast onto the Pub/Sub topic. A safety net — the nightly itself is a single tiny ephemeral cluster torn down each run."
  type        = number
  default     = 100

  validation {
    condition     = var.e2e_monthly_budget_usd > 0 && var.e2e_monthly_budget_usd <= 500
    error_message = "e2e_monthly_budget_usd must be a sane cap: 0 < amount <= 500 USD."
  }
}

variable "budget_publisher_binding_enabled" {
  description = <<-EOT
    Whether to manage the roles/pubsub.publisher grant to billing-budgets@system.gserviceaccount.com
    on the budget-alerts topic. Defaults FALSE because the principal does not exist on a billing
    account that has never had one, and no API we have found creates it — proven, not assumed: the
    notifying budget applied on 2026-08-03 and the binding still failed hours later behind an
    explicit depends_on (#1871). Leaving it declared unconditionally would mean this stack could
    never converge, blocking every unrelated change behind an uncreatable resource.

    Set to true ONLY after the grant exists out of band (Cloud Console), then `tofu import` the
    binding. While it is false the `budget_alerts_are_deliverable` check warns on every plan, so the
    missing cost guard is stated out loud rather than silently skipped.
  EOT
  type        = bool
  default     = false
}
