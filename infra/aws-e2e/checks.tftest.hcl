# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that infra/aws-e2e plans what it claims from the committed terraform.tfvars, and that its
# refusals and checks FIRE — a guard nobody has seen fail is indistinguishable from no guard.
#
# Plan-only and credential-free. The provider blocks below REPLACE the stack's (a test file's provider
# block overrides the configuration's), dropping the assume_role and allowed_account_ids so nothing
# calls STS; the one data source that would (aws_caller_identity) is overridden. The provider is the
# REAL one, not a mock, on purpose: aws_iam_policy_document renders locally, and a mocked one returns
# random JSON — every trust and boundary assertion below would then be about noise.
#
#   cd infra/aws-e2e && tofu init -backend=false && tofu test
# Run in CI by .github/workflows/infra-aws-e2e.yml.

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

provider "aws" {
  alias                       = "useast1"
  region                      = "us-east-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "556074788436"
  }
}

# Computed ARNs, as AWS would return them. A plan cannot know them, and `tofu test` fails a run whose
# check is unknown — so they are pinned here to the values the BUILT ARNs claim. The drift runs at the
# end replace one with a different value and expect the matching check to fire.
override_resource {
  target = aws_iam_openid_connect_provider.github
  values = {
    arn = "arn:aws:iam::556074788436:oidc-provider/token.actions.githubusercontent.com"
  }
}

override_resource {
  target = aws_iam_openid_connect_provider.e2e_broker
  values = {
    arn = "arn:aws:iam::556074788436:oidc-provider/e2e-issuer.alethialabs.io"
  }
}

override_resource {
  target = aws_iam_policy.e2e_boundary
  values = {
    arn = "arn:aws:iam::556074788436:policy/alethia-e2e/alethia-e2e-nightly-boundary"
  }
}

override_resource {
  target = aws_sns_topic.e2e_budget
  values = {
    arn = "arn:aws:sns:us-east-1:556074788436:alethia-e2e-nightly-budget-alerts"
  }
}

variables {
  # The one input that is never committed. [] is the explicit opt-out.
  e2e_budget_alert_emails = []
}

# ── The committed posture ────────────────────────────────────────────────────────────────────────

run "committed_posture_plans_the_same_trust_in_the_new_account" {
  command = plan

  assert {
    condition     = aws_iam_role.e2e_nightly.name == "alethia-e2e-nightly" && aws_iam_role.e2e_nightly.path == "/alethia-e2e/"
    error_message = "the role must keep infra/aws-oidc's name and path, so only the account in E2E_AWS_ROLE_ARN changes."
  }
  assert {
    condition = alltrue([
      strcontains(aws_iam_role.e2e_nightly.assume_role_policy, "repo:alethialabs-io/alethialabs:ref:refs/heads/main"),
      strcontains(aws_iam_role.e2e_nightly.assume_role_policy, "repo:alethialabs-io/alethialabs:environment:e2e-dev"),
    ])
    error_message = "the trust must carry the same two exact subjects as infra/aws-oidc's live role (main ref + e2e-dev environment)."
  }
  assert {
    # A literal, not local.github_oidc_provider_arn: the account and host are what is under test.
    condition     = strcontains(aws_iam_role.e2e_nightly.assume_role_policy, "arn:aws:iam::556074788436:oidc-provider/token.actions.githubusercontent.com")
    error_message = "the trust must federate the GitHub OIDC provider IN the e2e account."
  }
  assert {
    condition     = !strcontains(aws_iam_role.e2e_nightly.assume_role_policy, "270587882865")
    error_message = "nothing in the e2e role's trust may name the Alethia platform account."
  }
  assert {
    condition     = strcontains(aws_iam_role.e2e_nightly.assume_role_policy, "e2e-issuer.alethialabs.io:sub") && length(aws_iam_openid_connect_provider.e2e_broker) == 1
    error_message = "the committed broker origin must plan the broker provider and its trust statement."
  }
  assert {
    condition     = aws_iam_openid_connect_provider.github.url == "https://token.actions.githubusercontent.com" && tolist(aws_iam_openid_connect_provider.github.client_id_list) == tolist(["sts.amazonaws.com"])
    error_message = "the GitHub provider must trust the Actions issuer for the STS audience only."
  }
  assert {
    condition = alltrue([
      strcontains(aws_iam_policy.e2e_boundary.policy, "arn:aws:iam::556074788436:role/alethia-e2e-admin"),
      strcontains(aws_iam_policy.e2e_boundary.policy, "arn:aws:iam::556074788436:role/OrganizationAccountAccessRole"),
      strcontains(aws_iam_policy.e2e_boundary.policy, "arn:aws:secretsmanager:*:270587882865:secret:alethia/prod/env*"),
      strcontains(aws_iam_policy.e2e_boundary.policy, "arn:aws:sns:us-east-1:556074788436:alethia-e2e-nightly-budget-alerts"),
    ])
    error_message = "the boundary must protect the break-glass roles and the budget topic, and keep denying the prod vault by its platform-account ARN."
  }
  assert {
    condition     = aws_route53_zone.e2e.name == "e2e.alethialabs.io" && aws_route53_record.e2e_apex_ns.ttl == 300 && aws_route53_record.e2e_apex_ns.type == "NS"
    error_message = "the zone must be e2e.alethialabs.io, with its apex NS lowered to 300s."
  }
  assert {
    condition     = aws_budgets_budget.e2e_nightly.limit_amount == "50"
    error_message = "the committed budget must be the live ceiling of 50 USD."
  }
}

run "the_spend_reporter_is_a_narrow_reader_in_the_e2e_account" {
  command = plan

  assert {
    condition     = aws_iam_role.spend_reporter.name == "alethia-spend-reporter" && aws_iam_role.spend_reporter.path == "/alethia-e2e/"
    error_message = "the e2e reporter must be alethia-spend-reporter under /alethia-e2e/ (the path is what the boundary's DenyTamperWithGuardrails protects)."
  }
  assert {
    condition = alltrue([
      strcontains(aws_iam_role.spend_reporter.assume_role_policy, "repo:alethialabs-io/alethialabs:environment:spend-report"),
      strcontains(aws_iam_role.spend_reporter.assume_role_policy, "arn:aws:iam::556074788436:oidc-provider/token.actions.githubusercontent.com"),
      !strcontains(aws_iam_role.spend_reporter.assume_role_policy, "ref:refs/heads"),
      !strcontains(aws_iam_role.spend_reporter.assume_role_policy, "e2e-dev"),
      !strcontains(aws_iam_role.spend_reporter.assume_role_policy, "270587882865"),
    ])
    error_message = "the e2e reporter must trust ONLY the spend-report environment subject, through the e2e account's own GitHub provider."
  }
  assert {
    condition = alltrue([
      strcontains(aws_iam_role_policy.spend_reporter.policy, "ce:GetCostAndUsage"),
      strcontains(aws_iam_role_policy.spend_reporter.policy, "tag:GetResources"),
      !strcontains(aws_iam_role_policy.spend_reporter.policy, "secretsmanager"),
      !strcontains(aws_iam_role_policy.spend_reporter.policy, "tag:TagResources"),
    ])
    error_message = "the e2e reporter reads Cost Explorer and the tagging API, and nothing else - no secret, no tag write."
  }
  assert {
    condition     = !strcontains(aws_iam_role.e2e_nightly.assume_role_policy, "environment:spend-report")
    error_message = "the spend-report subject must not reach the nightly role."
  }
}

run "broker_unset_plans_no_broker_trust" {
  command = plan
  variables {
    e2e_broker_issuer_url = null
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.e2e_broker) == 0 && !strcontains(aws_iam_role.e2e_nightly.assume_role_policy, "E2EBrokerAssertion")
    error_message = "with the issuer unset, no broker provider and no broker statement may be planned."
  }
  assert {
    condition     = !strcontains(aws_iam_policy.e2e_boundary.policy, "e2e-issuer")
    error_message = "with the broker off, the boundary must not protect a provider that does not exist."
  }
}

# ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

run "the_prod_account_as_the_e2e_account_is_refused" {
  command = plan
  variables {
    e2e_account_id = "270587882865"
  }
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "270587882865"
    }
  }
  # The two preconditions (the nightly role's and the spend reporter's) are the refusal under test.
  # The three ARN checks fire too, and correctly: the
  # file-level overrides pin the providers and the topic to the e2e account, so every ARN built from
  # the (wrong) e2e_account_id disagrees with them.
  expect_failures = [
    aws_iam_role.e2e_nightly,
    aws_iam_role.spend_reporter,
    check.e2e_account_is_the_dedicated_one,
    check.github_oidc_provider_arn_matches,
    check.e2e_broker_provider_arn_matches,
    check.e2e_budget_topic_arn_matches,
  ]
}

run "a_provider_in_another_account_is_reported" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "111111111111"
    }
  }
  expect_failures = [check.e2e_account_is_the_dedicated_one]
}

run "an_apex_zone_is_refused" {
  command = plan
  variables {
    e2e_dns_zone_name = "alethialabs.io"
  }
  expect_failures = [var.e2e_dns_zone_name]
}

run "a_prod_region_is_refused" {
  command = plan
  variables {
    e2e_region = "eu-west-1"
  }
  expect_failures = [var.e2e_region]
}

run "a_wildcard_environment_is_refused" {
  command = plan
  variables {
    e2e_github_environment = "e2e-*"
  }
  expect_failures = [var.e2e_github_environment]
}

run "a_wildcard_spend_report_environment_is_refused" {
  command = plan
  variables {
    spend_reporter_environment = "spend-*"
  }
  expect_failures = [var.spend_reporter_environment]
}

run "an_issuer_with_a_path_is_refused" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethialabs.io/api/oidc"
  }
  expect_failures = [var.e2e_broker_issuer_url]
}

# ── The built ARNs are compared with the real ones ───────────────────────────────────────────────

run "a_github_provider_arn_that_drifts_is_reported" {
  command = plan
  override_resource {
    target = aws_iam_openid_connect_provider.github
    values = {
      arn = "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com"
    }
  }
  expect_failures = [check.github_oidc_provider_arn_matches]
}

run "a_broker_provider_arn_that_drifts_is_reported" {
  command = plan
  override_resource {
    target = aws_iam_openid_connect_provider.e2e_broker
    values = {
      arn = "arn:aws:iam::999999999999:oidc-provider/e2e-issuer.alethialabs.io"
    }
  }
  expect_failures = [check.e2e_broker_provider_arn_matches]
}

run "a_budget_topic_arn_that_drifts_is_reported" {
  command = plan
  override_resource {
    target = aws_sns_topic.e2e_budget
    values = {
      arn = "arn:aws:sns:eu-central-1:556074788436:alethia-e2e-nightly-budget-alerts"
    }
  }
  expect_failures = [check.e2e_budget_topic_arn_matches]
}
