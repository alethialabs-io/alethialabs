# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Repo governance as code: the dev→staging→main branch model, protection rulesets,
# and the deployer-role Actions variables. Replaces the manual `gh` steps in
# deploy/prod/README.md. Solo maintainer → CI-gated with NO required human approval
# (you can't approve your own PR); a second reviewer can be required later by bumping
# required_approving_review_count.

# Integration branch (feature PRs land here) forked off the RC branch.
resource "github_branch" "dev" {
  repository    = var.repository
  branch        = var.integration_branch
  source_branch = var.rc_branch
}

locals {
  # dev requires the same CI as main/staging MINUS branch-flow-guard: that check only runs on PRs into
  # main/staging (its `on: pull_request: branches: [main, staging]`), so requiring it on a dev PR would
  # wedge the merge — the check would be "expected" but never report.
  dev_required_status_checks = [for c in var.required_status_checks : c if c != "branch-flow-guard"]
}

# ── dev — integration branch. PR + green CI, NO approval (instances self-merge on green). ──
# Closes the gate into the shared integration branch: feature PRs can't land red or via direct push.
# The maintainer reviews the integrated dev (dev.alethialabs.io) and promotes dev → staging → main.
resource "github_repository_ruleset" "dev" {
  name        = "protect-dev"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/dev"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true
    # No required_linear_history: dev takes squash OR merge commits from feature PRs.

    pull_request {
      required_approving_review_count = 0 # CI is the gate; instances self-merge once green
      dismiss_stale_reviews_on_push   = true
    }

    required_status_checks {
      strict_required_status_checks_policy = false
      dynamic "required_check" {
        for_each = local.dev_required_status_checks
        content {
          context = required_check.value
        }
      }
    }
  }
}

# ── main — production. PR + green CI; no force-push/deletion. ──
# NOTE: linear history is intentionally NOT required. `staging → main` is promoted as a normal MERGE
# commit so main shares staging's/dev's history — required_linear_history=true forced squash promotions,
# and each squash then diverged main's graph from dev/staging, making the NEXT promotion falsely conflict
# (hit twice: the umami #110 and the consolidated-release #126, both needing a hotfix-off-main). Allowing
# merge commits keeps the branches convergent so promotions merge cleanly.
resource "github_repository_ruleset" "main" {
  name        = "protect-main"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/main"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    pull_request {
      required_approving_review_count = 0 # solo repo: CI is the gate, not a self-approval
      dismiss_stale_reviews_on_push   = true
      require_code_owner_review       = false
    }

    required_status_checks {
      strict_required_status_checks_policy = false
      dynamic "required_check" {
        for_each = var.required_status_checks
        content {
          context = required_check.value
        }
      }
    }
  }
  # No bypass_actors → admins are included (no bypass). The coverage-badge push in
  # ci.yml already degrades gracefully when blocked.
}

# ── staging — release candidate. PR + green CI (lighter; allows hotfix merges). ──
resource "github_repository_ruleset" "staging" {
  name        = "protect-staging"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/staging"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    pull_request {
      required_approving_review_count = 0
      dismiss_stale_reviews_on_push   = true
    }

    required_status_checks {
      strict_required_status_checks_policy = false
      dynamic "required_check" {
        for_each = var.required_status_checks
        content {
          context = required_check.value
        }
      }
    }
  }
}

# ── Deployer-role ARNs as Actions variables (consumed by the OIDC workflows) ──
resource "github_actions_variable" "cp_deployer" {
  count         = var.cp_deployer_role_arn != "" ? 1 : 0
  repository    = var.repository
  variable_name = "CP_HETZNER_DEPLOYER_ROLE_ARN"
  value         = var.cp_deployer_role_arn
}

resource "github_actions_variable" "runner_release_deployer" {
  count         = var.runner_release_deployer_role_arn != "" ? 1 : 0
  repository    = var.repository
  variable_name = "RUNNER_RELEASE_DEPLOYER_ROLE_ARN"
  value         = var.runner_release_deployer_role_arn
}

resource "github_actions_variable" "deploy_reader" {
  count         = var.deploy_reader_role_arn != "" ? 1 : 0
  repository    = var.repository
  variable_name = "DEPLOY_READER_ROLE_ARN"
  value         = var.deploy_reader_role_arn
}

resource "github_actions_variable" "connector_platform_deployer" {
  count         = var.connector_platform_deployer_role_arn != "" ? 1 : 0
  repository    = var.repository
  variable_name = "CONNECTOR_PLATFORM_DEPLOYER_ROLE_ARN"
  value         = var.connector_platform_deployer_role_arn
}

# Public origin (non-secret) consumed by deploy-console when assembling .env.
resource "github_actions_variable" "public_app_url" {
  repository    = var.repository
  variable_name = "PUBLIC_APP_URL"
  value         = var.public_app_url
}
