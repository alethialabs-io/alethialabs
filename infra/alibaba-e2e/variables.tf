# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ── GitHub OIDC scoping (parameterized — owner/repo can change without edits) ──

variable "github_repo" {
  description = "owner/repo whose Actions runs may assume the e2e RAM role via GitHub OIDC. The OIDC `sub` is bound EXACTLY to `repo:<this>:ref:refs/heads/<e2e_github_branch>` (StringEquals, never a wildcard) — PRs, forks and other branches cannot assume it."
  type        = string
  default     = "alethialabs-io/alethialabs"
}

variable "e2e_github_branch" {
  description = "Branch whose Actions runs may assume the e2e role. The e2e-nightly `schedule` trigger runs on the default branch, so this is `main`. Bound EXACTLY (non-wildcard) into the OIDC subject."
  type        = string
  default     = "main"
}

variable "github_issuer_url" {
  description = "GitHub Actions OIDC issuer. The RAM OIDC provider trusts this issuer and the trust `oidc:iss` pins it. Do not change unless GitHub changes its issuer."
  type        = string
  default     = "https://token.actions.githubusercontent.com"
}

variable "oidc_audience" {
  description = "The audience the GitHub OIDC token is minted with when the nightly assumes this role. For Alibaba AssumeRoleWithOIDC the convention is `sts.aliyuncs.com`; the RAM OIDC provider's client_ids and the trust `oidc:aud` both pin it. The nightly's token-request step MUST use this exact audience."
  type        = string
  default     = "sts.aliyuncs.com"
}

# ── Region ────────────────────────────────────────────────────────────────────
# Unlike AWS (where eu-central-1 hosts prod state/SES and eu-west-1 the fleet), Alethia runs NO
# prod infrastructure in any Alibaba region — so there is no prod region to fence away here. The
# region still matters: it is where the ephemeral ACK estate is provisioned + swept, and it MUST
# match the e2e-nightly default (eu-central-1 / Frankfurt) so the belt-and-suspenders sweeper
# (scripts/e2e/alibaba-cleanup.sh, region-locked from ALETHIA_E2E_REGION) targets the same region.
variable "region" {
  description = "The Alibaba region the e2e nightly provisions in (RAM itself is global; this pins the provider + is the region the sweeper is locked to). MUST be the e2e-nightly default eu-central-1 unless the workflow default is changed in lockstep."
  type        = string
  default     = "eu-central-1"

  validation {
    # Reject an empty/placeholder value and enforce the Alibaba region-id shape (e.g. eu-central-1,
    # cn-hangzhou, ap-southeast-1) so a typo can't silently point the provider at the wrong place.
    condition     = can(regex("^[a-z]{2,}-[a-z]+-?[0-9]*$", var.region))
    error_message = "region must be a valid Alibaba region id (e.g. eu-central-1, cn-hangzhou, ap-southeast-1)."
  }

  validation {
    # Alethia has no prod Alibaba footprint, but keep the guard shape (parity with the AWS stack's
    # e2e_region≠prod-region validation) so an operator who later adds prod Alibaba infra just adds
    # the region here.
    condition     = !contains(var.prod_regions, var.region)
    error_message = "region must not be one of prod_regions."
  }
}

variable "prod_regions" {
  description = "Alibaba regions that host prod Alethia infra and must NEVER be the e2e region. Empty today (no prod Alibaba footprint); populate if that changes."
  type        = list(string)
  default     = []
}

variable "account_id" {
  description = "Optional expected Alibaba account id (the 16-digit main-account uid). When non-empty, checks.tf asserts the applying identity matches it — a guard so the bootstrap is applied in the intended account. Empty = skip the assertion."
  type        = string
  default     = ""
}

variable "role_name" {
  description = "Name of the RAM role the e2e nightly assumes."
  type        = string
  default     = "alethia-e2e-nightly"
}

variable "oidc_provider_name" {
  description = "Name of the RAM OIDC provider trusting GitHub Actions. Distinct from the connector's `alethia` provider (which trusts the Alethia control-plane issuer, a different IdP)."
  type        = string
  default     = "alethia-github-e2e"
}
