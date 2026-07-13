# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "Region the provider operates in (IAM is global; used for the provider + STS)."
  type        = string
  default     = "eu-central-1"
}

variable "state_bucket_name" {
  description = "S3 bucket holding OpenTofu state for the control-plane + status stacks."
  type        = string
  default     = "alethia-tofu-state-270587882865"
}

variable "prod_env_secret_name" {
  description = "Secrets Manager secret holding the prod runtime + infra secrets (one JSON blob)."
  type        = string
  default     = "alethia/prod/env"
}

# ── GitHub OIDC scoping (parameterized — owner/repo can change without edits) ──

variable "github_repo" {
  description = "owner/repo whose Actions runs may assume the deploy roles via OIDC. Set after the org transfer."
  type        = string
  default     = "alethialabs-io/alethialabs"
}

variable "github_branch" {
  description = "Branch whose Actions runs may assume the deploy roles (the apply branch). Only main-triggered jobs (never PRs) can assume."
  type        = string
  default     = "main"
}

variable "github_environment" {
  description = "GitHub Actions environment whose jobs may assume the deploy roles. A job that sets `environment: <this>` gets an `...:environment:<this>` OIDC sub, which the trust also allows. Keep the environment branch-restricted to github_branch."
  type        = string
  default     = "production"
}

variable "oidc_provider_arn" {
  description = "ARN of the existing GitHub OIDC provider. Empty = look it up by URL (it already exists from infra/email-ses/bootstrap)."
  type        = string
  default     = ""
}

variable "admin_principal_arns" {
  description = "Extra IAM principals allowed to assume the deploy + e2e roles (e.g. an admin for local apply). Empty = OIDC only. Must be concrete IAM ARNs — a wildcard would open the roles to any AWS account."
  type        = list(string)
  default     = []

  validation {
    # A `*` here would render `Principal: { AWS: "*" }` — anyone, anywhere could assume these
    # (broadly-permissioned) roles. Require concrete arn:aws:iam:: principals.
    condition = alltrue([
      for a in var.admin_principal_arns : !strcontains(a, "*") && startswith(a, "arn:aws:iam::")
    ])
    error_message = "admin_principal_arns entries must be concrete arn:aws:iam:: ARNs with no '*' wildcard."
  }
}

# ── E2E nightly provisioning role (BYOC A1.1) ────────────────────────────────
# `alethia-e2e-nightly` is the OIDC role the T2 real-cloud nightly (.github/workflows/
# e2e-nightly.yml) assumes to provision + tear down a genuine, ephemeral AWS EKS cluster.
# Unlike the deploy roles above (S3/ECR-scoped), this one needs broad provisioning
# reach — so its blast radius is capped by a permissions boundary + a hard region lock +
# a monthly Budget, NOT by a narrow action list. It runs in the SHARED platform account,
# so the region lock keeps it off every prod region (state/SES eu-central-1, fleet eu-west-1).

variable "e2e_region" {
  description = "The single AWS region the e2e nightly may operate in (hard-denied everywhere else). Cheapest EC2 + the global-service home, so the region lock is a clean single-region allow. MUST NOT be a prod region (eu-central-1 / eu-west-1)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = !contains(["eu-central-1", "eu-west-1"], var.e2e_region)
    error_message = "e2e_region must not be a prod region (eu-central-1 hosts state/SES, eu-west-1 hosts the runner fleet)."
  }
}

variable "e2e_github_branch" {
  description = "Branch whose Actions runs may assume the e2e-nightly role. The `schedule` trigger runs on the default branch, so this is `main`. The OIDC `sub` is bound EXACTLY to `repo:<repo>:ref:refs/heads/<this>` (StringEquals, never a wildcard) — PRs and other branches cannot assume it."
  type        = string
  default     = "main"
}

variable "e2e_github_environment" {
  description = "Optional GitHub Actions environment to ADDITIONALLY trust (adds an exact `repo:<repo>:environment:<this>` sub). Empty = ref-only (tightest). Only set this if the nightly job pins `environment:` AND the environment is branch-restricted to e2e_github_branch."
  type        = string
  default     = ""
}

variable "e2e_monthly_budget_usd" {
  description = "Monthly cost ceiling (USD) for the e2e AWS spend. Alerts fire at 50/80/100% actual + 100% forecast. A safety net — the nightly itself is a single tiny ephemeral cluster torn down each run."
  type        = number
  default     = 100
}

variable "e2e_budget_alert_emails" {
  description = "Email addresses subscribed to the e2e budget SNS topic + notified directly by the Budget. Empty = SNS topic only (wire an automation/kill-switch later)."
  type        = list(string)
  default     = []
}

# ── Runner-release role resource scoping (release-runner / deploy-fleet-aws) ──

variable "runner_aws_region" {
  description = "Region of the runner ECR repo + ECS cluster."
  type        = string
  default     = "eu-west-1"
}

variable "runner_ecr_repository" {
  description = "ECR repository the runner image is pushed to."
  type        = string
  default     = "alethia-runner-dev-runner"
}

variable "runner_ecs_cluster" {
  description = "ECS cluster running the managed runner service."
  type        = string
  default     = "alethia-runner-dev-eu-west-1-cluster"
}

variable "runner_ecs_service" {
  description = "ECS service rolled on a new runner release."
  type        = string
  default     = "alethia-runner-dev-eu-west-1-service"
}
