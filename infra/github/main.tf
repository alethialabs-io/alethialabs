# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Repo governance as code: the feature → dev → main branch model (dev reaches main through a
# pinned release/<sha> promotion, promote.yml — the staging hop is retired), protection rulesets,
# and the deployer-role Actions variables. Replaces the manual `gh` steps in
# deploy/prod/README.md. Solo maintainer → CI-gated with NO required human approval
# (you can't approve your own PR); a second reviewer can be required later by bumping
# required_approving_review_count.

# Integration branch (feature PRs land here), originally forked off the old RC branch `staging`.
resource "github_branch" "dev" {
  repository    = var.repository
  branch        = var.integration_branch
  source_branch = var.rc_branch

  # `source_branch` matters only at creation, and the provider REPLACES the branch (delete + recreate,
  # i.e. dev reset to the source's tip) when it changes. With the staging hop retired, nothing may
  # ever let a plan propose that for `dev` — not a tidy-up of `rc_branch`, not the `staging` branch
  # being deleted. So a change to it is ignored outright.
  lifecycle {
    ignore_changes = [source_branch]
  }
}

locals {
  # dev requires the same checks as main MINUS branch-flow-guard and the seven release-gate legs.
  # branch-flow-guard runs only on PRs into main (its `on: pull_request: branches: [main]`), and the
  # gate legs run on a dev PR only when it carries a `release-gate:*` label (release-gate.yml's job
  # `if:`), so requiring either on dev would wedge the merge — "expected" but never reported.
  dev_required_status_checks = [for c in var.required_status_checks : c if c != "branch-flow-guard" && c != "Release gate (hero)" && c != "Release gate (elench-ai)" && c != "Release gate (console)" && c != "Release gate (canvas)" && c != "Release gate (qa)" && c != "Release gate (audit)" && c != "Release gate (audit-interaction)"]
}

# ── dev — integration branch. PR + green CI, NO approval; queued by MERGIFY. ──
# Closes the gate into the shared integration branch: feature PRs can't land red or via direct push.
# Promotions go dev → main through a pinned release/<sha> PR (promote.yml); see protect-main below.
#
# The merge QUEUE (the fix for the stale-green race, where two PRs each green against a now-stale dev broke
# the branch) is now driven by MERGIFY, not GitHub's native merge queue — see `.mergify.yml`. Mergify
# auto-queues every non-draft dev PR and squash-merges it in order once the required checks pass, validating
# each PR on its OWN branch. We removed the native `merge_queue` rule because its `merge_group`-only checks
# (the "Provisioning E2E (T1)" job, which fails on missing auth env) wedged every queued PR; Mergify has no
# `merge_group` event, so that wedge is gone. This ruleset still enforces `pull_request` + the required
# checks below (so nothing lands red or via direct push); Mergify does the ordered squash-merge on top.
# strict_required_status_checks_policy stays false — Mergify updates/rebases candidates itself.
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
      required_approving_review_count = 0 # CI is the gate; instances enqueue once green
      dismiss_stale_reviews_on_push   = true

      # UNRESOLVED REVIEW THREADS BLOCK THE MERGE (#3498). ⚠️ NOT APPLIED YET — see the ordering
      # note below; `.mergify.yml` leads this deliberately.
      #
      # Five PRs squash-merged with their /code-review findings unaddressed (#3433, #3437, #3444,
      # #3477, #3479 — by four, fifteen and five minutes) because a review is not a required check
      # and nothing else was consulted. Mergify's queue_conditions now refuse to enqueue a PR with
      # unresolved threads; this is the same intent expressed where it binds EVERY merge path.
      #
      # Why it is needed even though Mergify already refuses: CLAUDE.md §4 permits an instance to
      # merge a dev-targeted PR itself rather than waiting for the queue. That path never touches
      # Mergify, so the queue_conditions gate is bypassable by exactly the actor it constrains.
      # This rule is the half that is not.
      #
      # protect-dev ONLY. main receives promotions of the whole integrated branch,
      # where one stray inline comment would block a release; the review discipline this enforces
      # happens on feature PRs.
      #
      # ⚠️ THE ORDER IS NOT SYMMETRIC. Applied BEFORE the Mergify half has reached `main` (Mergify
      # reads its config only from the default branch), Mergify still queues and squash-merges,
      # GitHub refuses — protect-dev has no bypass actors — and the entry sits in the train with
      # nothing red to explain it. Mergify first, and apply only once the gate has been OBSERVED
      # blocking and releasing on a real PR.
      #
      # ⚠️ INVISIBLE TO THE DRIFT REPORT. `check-required-checks.mjs --live` compares only
      # `required_status_checks` context lists, so this sitting unapplied produces ZERO drift
      # signal and #3333 will not mention it. The apply that closes #3333 carries this rule with
      # it — an apply the maintainer may run believing it changes two check lists, which also
      # changes merge semantics.
      required_review_thread_resolution = true
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

    # No native `merge_queue` rule: the dev merge queue is Mergify (`.mergify.yml`, SQUASH, auto-queue every
    # non-draft PR). The native queue's `merge_group`-only T1 job wedged the whole queue; Mergify avoids it.
  }
}

# ── main — production. PR + green CI; no force-push/deletion. ──
# NOTE: linear history is intentionally NOT required. A promotion into main (release/<sha> → main today,
# staging → main before 2026-11-22) lands as a normal MERGE commit so main shares dev's history —
# required_linear_history=true forced squash promotions, and each squash then diverged main's graph
# from dev, making the NEXT promotion falsely conflict
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
  # No bypass_actors → admins are included (no bypass), and that includes github-actions[bot]:
  # the pull_request rule means EVERY update to refs/heads/main must arrive via a PR, so a direct
  # push from CI is refused with GH006 regardless of the token's contents:write permission.
  #
  # This comment used to say the coverage-badge push "already degrades gracefully when blocked".
  # It degraded so gracefully that both badge jobs failed silently from the day this ruleset was
  # created (2026-07-03) until 2026-08-05, and the README advertised 21.6% Go coverage against a
  # real 61.2%. The jobs now publish to the unprotected orphan `badges` branch and no longer
  # swallow the push failure. Do not add a bypass actor here to "fix" a badge.
}

# ── require_extra_approval_for_unattributed_changes = FALSE, re-asserted after every ruleset write ──
#
# THE DECISION (maintainer, 2026-11-25, #7654): this `pull_request` rule parameter is FALSE on both
# protect-dev (18583159) and protect-main (18465988). The orchestrator set it live that day with
# `gh api -X PUT`. GitHub's REST reference describes it as extra approval for a PR that Copilot opens
# without a human collaborator.
#
# WHY IT CANNOT LIVE IN THE RULESET BLOCKS ABOVE. `integrations/github` 6.12.1 has no attribute for
# it, and neither has 6.13.0 (what `~> 6.0` resolved to on 2026-11-25; read with `tofu providers
# schema -json`). The ruleset schema's `pull_request` block has allowed_merge_methods, dismiss_stale_reviews_on_push,
# require_code_owner_review, require_last_push_approval, required_approving_review_count,
# required_review_thread_resolution and required_reviewers, and nothing else. The provider therefore
# PUTs a `pull_request` rule that OMITS the field on every create and update. GitHub then sets it
# TRUE (#7654's finding; scripts/ci/fixtures/rules-branches.2026-09-23.json, a verbatim capture of
# both branches' rules, reads `true` on each, which is that default in force before anyone chose).
# So without this resource, the next apply that writes either ruleset would silently undo the
# decision, and the plan would not show it.
#
# HOW. One `terraform_data` per ruleset, with `lifecycle.replace_triggered_by` naming that ruleset.
# OpenTofu replaces a resource when "a plan to update or replace that instance" of the referenced
# resource exists (OpenTofu docs, "Resource behavior", replace_triggered_by), so every apply that
# writes a ruleset also replaces its `terraform_data`, and replacing it runs the local-exec below
# AFTER the ruleset write (it reads the ruleset's id, so it depends on it). The script:
#   · GETs the LITERAL path `repos/<owner>/<repo>/rulesets/<numeric id>` (a non-numeric id is refused
#     before any call);
#   · exits 0 without writing when every `pull_request` rule already reads `false`;
#   · otherwise PUTs `{"rules": [...]}`, the rules array it just read with ONLY that one field set to
#     false. Name, target, enforcement, conditions and bypass actors are left out of the body, so the
#     PUT cannot change them; every other rule and parameter goes back exactly as it was read;
#   · reads the ruleset again and fails the apply unless the field is now false.
#
# WHY NOT A TRIGGER ON THE RULESET'S `etag`, which was the first design. The provider changes `etag`
# on every write, but its plan does not mark it unknown for an in-place update (the ruleset's
# CustomizeDiff only validates), so the plan would carry the OLD etag into `triggers_replace` and the
# apply would hand it a new one: an inconsistent final plan at best, a missed run at worst. It would
# also replace this resource again on the plan after every PUT here, since that PUT moves the etag.
# `replace_triggered_by` asks the plan itself whether the ruleset is being written, which is the
# question. Our own PUT leaves no diff behind: the provider cannot see this field, and `etag` is
# computed, so the next plan is clean.
#
# WHAT IT DOES NOT COVER, stated. Someone flipping the flag back to true by hand, with no other
# change, produces no plan for the ruleset, so no apply will re-assert it. That case is the drift
# check's: `node scripts/ci/check-required-checks.mjs --live` (workflow-health.yml) reports drift,
# and opens its tracker issue, when either branch reads `true`.
#
# It runs where `tofu apply` runs and needs `gh` and `jq` on PATH. It uses the same token as the
# provider (`var.github_token`, which needs Administration write for the rulesets anyway).
# `node scripts/ci/check-required-checks.mjs` fails if a ruleset with a `pull_request` block has no
# such resource wired to it.
locals {
  reassert_unattributed_changes_false = <<-EOT
    set -euo pipefail
    case "$RULESET_ID" in
      '' | *[!0-9]*) echo "ruleset id '$RULESET_ID' is not numeric; refusing to write" >&2; exit 1 ;;
    esac
    path="repos/$OWNER/$REPO/rulesets/$RULESET_ID"
    flags_of() { jq -c '[.rules[] | select(.type == "pull_request") | .parameters.require_extra_approval_for_unattributed_changes]'; }
    current="$(gh api "$path")"
    before="$(flags_of <<<"$current")"
    if [ "$before" = "[]" ]; then
      echo "$path has no pull_request rule, so there is nothing to re-assert; the HCL says otherwise" >&2
      exit 1
    fi
    if [ "$(jq -c 'map(. == false) | all' <<<"$before")" = "true" ]; then
      echo "$path: require_extra_approval_for_unattributed_changes already false; nothing written"
      exit 0
    fi
    jq -c '{rules: [.rules[] | if .type == "pull_request" then .parameters.require_extra_approval_for_unattributed_changes = false else . end]}' <<<"$current" \
      | gh api -X PUT "$path" --input - >/dev/null
    after="$(gh api "$path" | flags_of)"
    if [ "$(jq -c 'length > 0 and (map(. == false) | all)' <<<"$after")" != "true" ]; then
      echo "$path: after the PUT the field reads $after, not false" >&2
      exit 1
    fi
    echo "$path: require_extra_approval_for_unattributed_changes $before -> $after"
  EOT
}

resource "terraform_data" "dev_ruleset_unattributed_changes_false" {
  triggers_replace = [github_repository_ruleset.dev.ruleset_id]

  lifecycle {
    replace_triggered_by = [github_repository_ruleset.dev]
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = local.reassert_unattributed_changes_false
    environment = {
      GH_TOKEN   = var.github_token
      OWNER      = var.github_owner
      REPO       = var.repository
      RULESET_ID = tostring(github_repository_ruleset.dev.ruleset_id)
    }
  }
}

resource "terraform_data" "main_ruleset_unattributed_changes_false" {
  triggers_replace = [github_repository_ruleset.main.ruleset_id]

  lifecycle {
    replace_triggered_by = [github_repository_ruleset.main]
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = local.reassert_unattributed_changes_false
    environment = {
      GH_TOKEN   = var.github_token
      OWNER      = var.github_owner
      REPO       = var.repository
      RULESET_ID = tostring(github_repository_ruleset.main.ruleset_id)
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

# Public origin (non-secret) consumed by deploy-console when assembling .env.
resource "github_actions_variable" "public_app_url" {
  repository    = var.repository
  variable_name = "PUBLIC_APP_URL"
  value         = var.public_app_url
}
