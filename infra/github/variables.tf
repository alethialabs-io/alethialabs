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

# Read ONLY when `dev` is first created. The staging hop is retired (promotions go dev → main through
# release/<sha>, promote.yml), but this default is deliberately left alone: a change to
# `github_branch.dev`'s `source_branch` forces a REPLACEMENT — delete and recreate the dev branch — so
# main.tf also makes that resource ignore changes to it. Do not "tidy" this to "main".
variable "rc_branch" {
  description = "Branch the integration branch was originally created from (read only at creation)."
  type        = string
  default     = "staging"
}

variable "required_status_checks" {
  description = "Check contexts that must pass before merge. Filtered per ruleset in main.tf."
  type        = list(string)
  # Matrix jobs report their status-check context WITH the matrix suffix, e.g.
  # "Release gate (hero)" — the bare name is never reported, so requiring it would wedge every
  # merge. List each matrix leg explicitly.
  default = [
    # ci.yml's aggregator job (`ci-required`). It `needs:` every required job of that workflow and
    # is green only when each one concluded `success` or `skipped`; red on a failure or a cancel,
    # and it runs with `if: always()`, so it reports on every PR. ITS `needs:` LIST IS THE SOURCE OF
    # TRUTH for which CI jobs gate a merge — adding a required CI job is an edit there, not here.
    # It replaced eleven per-job contexts on 2026-11-22 (TypeScript, the three Go legs, Integration,
    # Secret scan, Docs prose, Authz / open-core guards, capabilities-security, Build console
    # images, BYO users SQL); why each job is required is recorded at the job in ci.yml.
    "CI required",
    # Enforces feature → dev → main through a pinned release/<sha> promotion: fails a PR into main
    # from a disallowed source branch → mis-targeted PRs (e.g. feature → main) are un-mergeable.
    # See .github/workflows/branch-flow-guard.yml. It runs only on PRs into main, so main.tf filters
    # it out of dev.
    "branch-flow-guard",
    # Pre-registration: blocks outside contributions while the recipient entity and CLA are not
    # active. After registration this same workflow is replaced by the versioned CLA signing gate.
    # It always reports for pull requests, including founder/bot and promotion PRs. It comes from
    # cla.yml, a separate `pull_request_target` workflow, so the CI aggregator above cannot cover it
    # (`needs:` cannot reach across workflows) and it is listed on its own.
    "contribution-legal",
    # THE BROWSER RELEASE GATE (.github/workflows/release-gate.yml). Production deploys on a push to
    # main, and main only takes promotions (release/<sha>), release-please PRs and hotfixes, so
    # requiring these on main is "before every production deployment". A matrix — one context per
    # leg, listed literally as the comment at the top of this list demands — because the legs finish
    # at different times and a promotion should read which one is red. They are filtered OUT of dev
    # in main.tf: the gate runs on a dev PR only when it is labelled for it, so on every other dev PR
    # the context never reports and Mergify would wedge on it.
    "Release gate (hero)",
    "Release gate (elench-ai)",
    "Release gate (console)",
    "Release gate (canvas)",
    "Release gate (qa)",
    "Release gate (audit)",
    # The one gate leg that ACTIVATES controls: it opens every destructive control the registry
    # records, asserts the declared confirmation and presses Cancel (#4266). Required on main like
    # its siblings and filtered out of dev in main.tf, for the same reason they are.
    "Release gate (audit-interaction)",
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
