# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "github_owner" {
  description = "Repo owner (org after transfer)."
  type        = string
  default     = "alethialabs-io"
}

variable "repository" {
  description = "Repository name (without owner)."
  type        = string
  default     = "alethialabs"
}

variable "github_token" {
  description = "GitHub App installation token (from actions/create-github-app-token). Needs Administration + Contents + Actions-variables write."
  type        = string
  sensitive   = true
}

variable "integration_branch" {
  description = "Long-lived integration branch created off the RC branch."
  type        = string
  default     = "dev"
}

variable "rc_branch" {
  description = "Release-candidate branch the integration branch forks from."
  type        = string
  default     = "staging"
}

variable "required_status_checks" {
  description = "CI check contexts (ci.yml job names) that must pass before merge."
  type        = list(string)
  # Matrix jobs report their status-check context WITH the matrix suffix, e.g.
  # "Go (build · vet · test · lint) (apps/cli)" — the bare name is never reported, so
  # requiring it would wedge every merge. List each matrix leg explicitly.
  default = [
    "TypeScript (lint · types · test · docs)",
    "Integration (real Postgres + RLS)",
    "Go (build · vet · test · lint) (apps/cli)",
    "Go (build · vet · test · lint) (packages/core)",
    "Go (build · vet · test · lint) (apps/runner)",
    "Authz / open-core guards",
    "Secret scan (gitleaks)",
    # The docs-prose job ALWAYS runs (steps self-gate on the `docs` path filter), so it reports its
    # check on every PR — safe to require without wedging non-docs PRs. Blocks only on error-level
    # Vale alerts (wrong product terminology). See .github/workflows/ci.yml → docs-prose.
    "Docs prose (Vale · Diátaxis + plain-language)",
    # Enforces feature → dev → staging → main: fails a PR into main/staging from a disallowed source
    # branch → mis-targeted PRs (e.g. feature → main) are un-mergeable. See .github/workflows/branch-flow-guard.yml.
    "branch-flow-guard",
    # The automated capabilities-security gate (replaces the dropped #982 CODEOWNERS review — a sole-owner
    # human gate would deadlock the no-approval Mergify queue). Runs on EVERY PR and no-op-passes (green)
    # when no capabilities/connector/keyless path changed; fail-closes on the deterministic
    # alethia-security-review invariants when those paths DID change. See
    # .github/workflows/capabilities-security.yml. SAFE to require: it always reports (unfiltered job), so
    # it never wedges an unrelated PR the way a path-filtered required check would.
    "capabilities-security",
  ]
}

# Deployer-role ARNs from infra/aws-oidc — published as repo Actions variables so the
# OIDC-migrated workflows can reference `${{ vars.* }}`. Empty = skip (set later).
variable "cp_deployer_role_arn" {
  description = "alethia-cp-deployer role ARN → Actions var CP_HETZNER_DEPLOYER_ROLE_ARN."
  type        = string
  default     = ""
}

variable "runner_release_deployer_role_arn" {
  description = "alethia-runner-release-deployer role ARN → Actions var RUNNER_RELEASE_DEPLOYER_ROLE_ARN."
  type        = string
  default     = ""
}

variable "deploy_reader_role_arn" {
  description = "alethia-deploy-reader role ARN → Actions var DEPLOY_READER_ROLE_ARN (deploy-console reads ASM)."
  type        = string
  default     = ""
}

variable "public_app_url" {
  description = "Public origin → Actions var PUBLIC_APP_URL (drives NEXT_PUBLIC_APP_URL etc. in deploy-console)."
  type        = string
  default     = "https://alethialabs.io"
}
