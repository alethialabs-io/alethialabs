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
  description = "Extra IAM principals allowed to assume the deploy roles (e.g. an admin for local apply). Empty = OIDC only."
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
