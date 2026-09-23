# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the E2E assertion broker trust (#4226, e2e-broker.tf) plans what it claims, plans
# NOTHING while unset, and leaves the GitHub credentials alone.
#
# Providers are mocked, so this needs no credentials. No workflow runs it today; run it with
# `tofu init -backend=false && tofu test` from this directory.

mock_provider "azurerm" {
  mock_data "azurerm_subscription" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000000" }
  }
}
mock_provider "azuread" {
  # The provider validates owners as UUIDs even under a mock, so the random string it invents fails.
  mock_data "azuread_client_config" {
    defaults = {
      object_id = "11111111-1111-1111-1111-111111111111"
      tenant_id = "22222222-2222-2222-2222-222222222222"
    }
  }
  mock_resource "azuread_application" {
    defaults = { id = "/applications/33333333-3333-3333-3333-333333333333", client_id = "44444444-4444-4444-4444-444444444444" }
  }
  mock_resource "azuread_service_principal" {
    defaults = { object_id = "55555555-5555-5555-5555-555555555555" }
  }
  mock_resource "azuread_group" {
    defaults = { object_id = "66666666-6666-6666-6666-666666666666", id = "/groups/66666666-6666-6666-6666-666666666666" }
  }
}

variables {
  subscription_id         = "00000000-0000-0000-0000-000000000000"
  e2e_budget_alert_emails = []
  # Overrides terraform.tfvars' "e2e-dev" so the `env` credential is NOT planned here. imports.tf
  # adopts that credential with an import block, and OpenTofu (verified on 1.12.3) CRASHES when a
  # test plan reaches an import: "Importing is not supported in testing context". With no `env`
  # instance the import's for_each is empty and the plan never calls it — which also proves that
  # branch plans cleanly. The cost: these runs cover the `ref` credential only.
  e2e_github_environment = ""
}

# Trust OFF: with the issuer unset nothing is created. Set explicitly — terraform.tfvars now carries the
# real origin (#4226), so the default posture is no longer "off".
run "unset_plans_no_broker_credential" {
  command = plan
  variables {
    e2e_broker_issuer_url = null
  }

  assert {
    condition     = length(azuread_application_federated_identity_credential.e2e_broker) == 0
    error_message = "with e2e_broker_issuer_url unset there must be no broker federated credential."
  }
}

run "set_adds_one_exact_credential_beside_github" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethia-e2e-issuer.example.workers.dev"
  }

  assert {
    # Literals, not locals: these are the values broker.ts carries today, so a change there (or a
    # regex that extracts the wrong key) fails here instead of passing by construction.
    condition = alltrue([
      azuread_application_federated_identity_credential.e2e_broker[0].issuer == "https://alethia-e2e-issuer.example.workers.dev",
      azuread_application_federated_identity_credential.e2e_broker[0].subject == "alethia-connector",
      azuread_application_federated_identity_credential.e2e_broker[0].audiences == tolist(["api://AzureADTokenExchange"]),
    ])
    error_message = "the broker credential must pin the issuer, subject alethia-connector and audience api://AzureADTokenExchange exactly."
  }
  assert {
    condition = alltrue([
      for c in azuread_application_federated_identity_credential.github : c.issuer == "https://token.actions.githubusercontent.com"
    ])
    error_message = "the GitHub credentials must be untouched by the broker's arrival."
  }
}

run "an_issuer_with_a_path_is_refused" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethialabs.io/api/oidc"
  }
  expect_failures = [var.e2e_broker_issuer_url]
}

# The committed posture (#4226, maintainer ruling 2026-09-23): terraform.tfvars names the Cloudflare
# custom domain infra/e2e-issuer binds, so an apply of this stack plans the broker credential at exactly it.
run "committed_posture_trusts_the_custom_domain" {
  command = plan

  assert {
    condition     = azuread_application_federated_identity_credential.e2e_broker[0].issuer == "https://e2e-issuer.alethialabs.io"
    error_message = "the committed issuer must be https://e2e-issuer.alethialabs.io — the host infra/e2e-issuer serves."
  }
}
