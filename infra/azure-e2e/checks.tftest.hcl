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
}

# The committed posture: terraform.tfvars sets the issuer to null, so nothing is created.
run "unset_plans_no_broker_credential" {
  command = plan

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
