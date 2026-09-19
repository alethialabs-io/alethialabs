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

variable "e2e_github_environment" {
  description = <<-EOT
    Optional GitHub Actions environment to ADDITIONALLY trust. Adds an exact
    `assertion.sub == repo:<repo>:environment:<this>` disjunct to the provider's attribute condition,
    alongside — never instead of — the ref equality. Empty = ref-only (tightest), and the rendered
    condition is then byte-identical to the previous ref-only form.

    Set this ONLY when the environment is branch-restricted, because the environment's own
    deployment-branch policy is what actually pins which branch may federate; this trust says only
    "that environment". Keying on the SUBJECT rather than adding a second ref is deliberate: a second
    ref would trust every workflow running on that branch, where the subject narrows it to a job that
    declared the environment.

    Used for `e2e-dev` (policy: `dev` only), so a workflow_dispatch can drive a real apply from `dev`
    without a promotion to `main`. The scheduled nightly is unaffected — it federates by ref.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.e2e_github_environment == "" || !strcontains(var.e2e_github_environment, "*")
    error_message = "e2e_github_environment must be a concrete environment name with no '*' wildcard."
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
    Whether to manage the roles/pubsub.publisher grant to the billing-budgets service agent on the
    budget-alerts topic.

    Defaults TRUE since 2026-08-27. It was false because the grant could not be created: #1871
    proved `billing-budgets@system.gserviceaccount.com` does not exist on a billing account that
    has never had one, and no API we found creates it. That principal was simply the WRONG NAME.
    The Console's budget UI grants `billing-budget-alert@system.gserviceaccount.com`, which does
    exist, and that binding is live on this project's topic today — so the grant was never
    uncreatable, it was unaddressable.

    Set to false only if a project genuinely has no such binding and cannot get one; the
    `budget_alerts_are_deliverable` check then warns on every plan, so a missing cost guard is
    stated out loud rather than silently skipped.
  EOT
  type        = bool
  default     = true
}

# ── E2E assertion broker (#4226) ─────────────────────────────────────────────
variable "e2e_broker_issuer_url" {
  description = <<-EOT
    The HTTPS origin of the E2E assertion broker (apps/e2e-issuer) — exactly the `E2E_ISSUER_URL` the
    Worker is deployed with, which is the `iss` of every assertion it mints. null (the committed value
    in terraform.tfvars) creates NO broker trust, so a plan without it changes nothing.

    A bare origin only: no path, no port, no trailing slash, lowercase host. That is the only shape
    the Worker serves (normalizedIssuer() in apps/e2e-issuer/src/worker.ts refuses anything with a
    path), every cloud compares `iss` byte-for-byte, and it keeps the console's own issuer
    (https://alethialabs.io/api/oidc, which HAS a path) from being pasted here by mistake.

    Choosing the origin is the maintainer's decision (#4547); see
    docs/testing/e2e-federation-apply-runbook.md. Set it in terraform.tfvars in a reviewed PR, never
    with -var at apply time: the next bare apply would read null and REMOVE the trust.
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

variable "e2e_broker_workflow_refs" {
  description = <<-EOT
    The exact `workflow_ref` claims the broker trust admits (CEL list membership, never a prefix).
    MUST equal the broker's own ALLOWED_WORKFLOW_REFS deployment variable (apps/e2e-issuer/README.md):
    the broker refuses to mint for any other ref, and this is GCP's independent copy of the same pin.
    The default is the value proposed for that variable on #4226 — the nightly dispatched from `dev`.
    Only read while e2e_broker_issuer_url is set.
  EOT
  type        = list(string)
  default     = ["alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev"]

  validation {
    condition = alltrue([
      for r in var.e2e_broker_workflow_refs :
      can(regex("^[^/\\s\"*]+/[^/\\s\"*]+/\\.github/workflows/[^@\\s\"*]+@refs/(heads|tags)/[^\\s\"*]+$", r))
    ])
    error_message = "each e2e_broker_workflow_refs entry must be an exact <owner>/<repo>/.github/workflows/<file>@refs/(heads|tags)/<name>, with no '*', quote or whitespace."
  }
}

variable "broker_pool_id" {
  description = "Workload Identity Pool ID for the E2E assertion broker trust. Its own pool, never the GitHub one — see e2e-broker.tf. A destroyed pool's ID stays reserved for 30 days."
  type        = string
  default     = "alethia-e2e-broker"
}

variable "broker_provider_id" {
  description = "Workload Identity Pool Provider ID for the E2E assertion broker."
  type        = string
  default     = "alethia-e2e-broker-oidc"
}
