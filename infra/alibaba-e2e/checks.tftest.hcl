# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the E2E assertion broker trust (#4226, e2e-broker.tf) plans what it claims, plans
# NOTHING while unset, leaves the GitHub statement where every other check reads it, and that its
# guards fire — a guard nobody has seen fail is indistinguishable from no guard.
#
# Providers are mocked, so this needs no credentials and makes no network call (the two
# tls_certificate reads are overridden). No workflow runs it today; run it with
# `tofu init -backend=false && tofu test` from this directory.

mock_provider "alicloud" {
  # terraform.tfvars pins account_id; a random mock id would fire e2e_applies_in_expected_account.
  mock_data "alicloud_caller_identity" {
    defaults = { account_id = "5767983785483306" }
  }
}
mock_provider "tls" {}

# The broker provider's real ARN, as RAM would return it. Every run that enables the broker compares
# the BUILT ARN (local.broker_provider_arn) with this, through check.e2e_broker_provider_arn_matches.
override_resource {
  target = alicloud_ims_oidc_provider.e2e_broker
  values = {
    arn = "acs:ram::5767983785483306:oidc-provider/alethia-e2e-broker"
  }
}

override_data {
  target = data.tls_certificate.github
  values = {
    certificates = [
      {
        is_ca               = true, sha1_fingerprint = "1111111111111111111111111111111111111111", cert_pem = "", issuer = "", max_path_length = 0,
        not_after           = "", not_before = "", public_key_algorithm = "", serial_number = "",
        signature_algorithm = "", subject = "", version = 3
      },
    ]
  }
}

override_data {
  target = data.tls_certificate.e2e_broker
  values = {
    certificates = [
      {
        is_ca               = true, sha1_fingerprint = "2222222222222222222222222222222222222222", cert_pem = "", issuer = "", max_path_length = 0,
        not_after           = "", not_before = "", public_key_algorithm = "", serial_number = "",
        signature_algorithm = "", subject = "", version = 3
      },
      {
        is_ca               = false, sha1_fingerprint = "3333333333333333333333333333333333333333", cert_pem = "", issuer = "", max_path_length = 0,
        not_after           = "", not_before = "", public_key_algorithm = "", serial_number = "",
        signature_algorithm = "", subject = "", version = 3
      },
    ]
  }
}

# The committed posture: terraform.tfvars sets the issuer to null, so nothing is created and the trust
# document holds the GitHub statement alone.
run "unset_plans_no_broker_trust" {
  command = plan

  assert {
    condition = alltrue([
      length(alicloud_ims_oidc_provider.e2e_broker) == 0,
      length(jsondecode(alicloud_ram_role.e2e.assume_role_policy_document).Statement) == 1,
    ])
    error_message = "with e2e_broker_issuer_url unset there must be no broker provider and a one-statement trust."
  }
}

run "set_appends_an_exact_second_statement" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethia-e2e-issuer.example.workers.dev"
  }

  assert {
    condition     = length(jsondecode(alicloud_ram_role.e2e.assume_role_policy_document).Statement) == 2
    error_message = "the broker statement must be APPENDED — two statements in all."
  }
  assert {
    condition     = jsondecode(alicloud_ram_role.e2e.assume_role_policy_document).Statement[0].Condition.StringEquals["oidc:iss"] == "https://token.actions.githubusercontent.com"
    error_message = "Statement[0] must still be the GitHub statement."
  }
  assert {
    # Literals, not locals: these are the values broker.ts carries today, so a change there (or a
    # regex that extracts the wrong key) fails here instead of passing by construction.
    condition = jsondecode(alicloud_ram_role.e2e.assume_role_policy_document).Statement[1].Condition.StringEquals == {
      "oidc:iss" = "https://alethia-e2e-issuer.example.workers.dev"
      "oidc:aud" = "sts.aliyuncs.com"
      "oidc:sub" = ["alethia-connector"]
    }
    error_message = "the broker statement must pin exactly oidc:iss, oidc:aud = sts.aliyuncs.com and oidc:sub = [alethia-connector]."
  }
  assert {
    # A literal built from the MOCKED DATA SOURCE (account id) and the provider name — not from the
    # provider resource's computed `arn`. A principal read off `arn` would make the whole document
    # unknown on a real enabling plan; this is the value a maintainer reads there.
    condition     = jsondecode(alicloud_ram_role.e2e.assume_role_policy_document).Statement[1].Principal.Federated == ["acs:ram::5767983785483306:oidc-provider/alethia-e2e-broker"]
    error_message = "the broker statement must federate the broker provider by an ARN built from plan-time values."
  }
  assert {
    condition = alltrue([
      alicloud_ims_oidc_provider.e2e_broker[0].issuance_limit_time == 1,
      alicloud_ims_oidc_provider.e2e_broker[0].client_ids == toset(["sts.aliyuncs.com"]),
      # The CA cert only, never the leaf.
      alicloud_ims_oidc_provider.e2e_broker[0].fingerprints == toset(["2222222222222222222222222222222222222222"]),
    ])
    error_message = "the broker provider must pin the audience, the narrowest issuance limit and the CA fingerprint only."
  }
}

run "an_issuer_with_a_path_is_refused" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethialabs.io/api/oidc"
  }
  expect_failures = [var.e2e_broker_issuer_url]
}

run "sharing_the_github_provider_name_is_reported" {
  command = plan
  variables {
    e2e_broker_issuer_url     = "https://alethia-e2e-issuer.example.workers.dev"
    broker_oidc_provider_name = "alethia-github-e2e"
  }
  # Keep the built ARN and the "real" one in agreement, so the only check that fires is the one under test.
  override_resource {
    target = alicloud_ims_oidc_provider.e2e_broker
    values = {
      arn = "acs:ram::5767983785483306:oidc-provider/alethia-github-e2e"
    }
  }
  expect_failures = [check.e2e_broker_trust_is_additive]
}

# The built ARN disagrees with the provider RAM actually created: the statement would federate a
# provider that does not exist, and the check must say so.
run "a_built_provider_arn_that_drifts_is_reported" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethia-e2e-issuer.example.workers.dev"
  }
  override_resource {
    target = alicloud_ims_oidc_provider.e2e_broker
    values = {
      arn = "acs:ram::1111111111111111:oidc-provider/alethia-e2e-broker"
    }
  }
  # The statement still carries the BUILT ARN, not the resource's. This is the assertion that fails if
  # the principal is ever read off alicloud_ims_oidc_provider.e2e_broker[0].arn again — the form that
  # is `(known after apply)` on a real enabling plan. (In the run above both values agree, so it
  # cannot tell them apart; here they differ.)
  assert {
    condition     = jsondecode(alicloud_ram_role.e2e.assume_role_policy_document).Statement[1].Principal.Federated == ["acs:ram::5767983785483306:oidc-provider/alethia-e2e-broker"]
    error_message = "the broker statement must name the provider by the ARN built from plan-time values, not by the resource's computed arn."
  }
  expect_failures = [check.e2e_broker_provider_arn_matches]
}
