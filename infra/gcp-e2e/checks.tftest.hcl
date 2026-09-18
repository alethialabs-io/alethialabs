# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the E2E assertion broker trust (#4226, e2e-broker.tf) plans what it claims, plans
# NOTHING while unset, and that its guards fire — a guard nobody has seen fail is indistinguishable
# from no guard.
#
# Providers are mocked, so this needs no credentials. No workflow runs it today (only aws-oidc has an
# infra-* workflow); run it with `tofu init -backend=false && tofu test` from this directory.

mock_provider "google" {
  # The provider validates these shapes even under a mock, so the random strings it invents fail.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/alethia-e2e-mock/serviceAccounts/alethia-e2e-nightly@alethia-e2e-mock.iam.gserviceaccount.com"
      email = "alethia-e2e-nightly@alethia-e2e-mock.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_iam_workload_identity_pool" {
    defaults = {
      name = "projects/123456789012/locations/global/workloadIdentityPools/mock-pool"
    }
  }
}

variables {
  project_id         = "alethia-e2e-mock"
  billing_account_id = "000000-000000-000000"
}

# The committed posture: terraform.tfvars sets the issuer to null, so nothing is created.
run "unset_plans_no_broker_trust" {
  command = plan

  assert {
    condition = alltrue([
      length(google_iam_workload_identity_pool.e2e_broker) == 0,
      length(google_iam_workload_identity_pool_provider.e2e_broker) == 0,
      length(google_service_account_iam_member.e2e_broker) == 0,
    ])
    error_message = "with e2e_broker_issuer_url unset, no broker pool, provider or SA member may be planned."
  }
}

run "set_pins_issuer_audience_subject_and_run" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethia-e2e-issuer.example.workers.dev"
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.e2e_broker[0].oidc[0].issuer_uri == "https://alethia-e2e-issuer.example.workers.dev"
    error_message = "the broker provider must trust exactly the configured issuer."
  }
  assert {
    # A literal, not local.broker_audience: this is the value broker.ts carries today, so a change
    # there (or a regex that extracts the wrong key) fails here instead of passing by construction.
    condition     = google_iam_workload_identity_pool_provider.e2e_broker[0].oidc[0].allowed_audiences == tolist(["alethia-gcp-wif"])
    error_message = "the broker provider must pin the gcp audience from WORKLOAD_PROVIDER_AUDIENCES."
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.e2e_broker[0].attribute_condition == "assertion.sub == \"alethia-connector\" && assertion.provider == \"gcp\" && assertion.repository == \"alethialabs-io/alethialabs\" && assertion.workflow_ref in [\"alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev\"]"
    error_message = "the attribute condition must pin sub, provider, repository and workflow_ref exactly."
  }
  assert {
    condition     = google_iam_workload_identity_pool.e2e_broker[0].workload_identity_pool_id != google_iam_workload_identity_pool.e2e.workload_identity_pool_id
    error_message = "the broker must live in its own pool."
  }
}

run "an_issuer_with_a_path_is_refused" {
  command = plan
  variables {
    # The console's own issuer — the mistake the bare-origin rule exists to stop.
    e2e_broker_issuer_url = "https://alethialabs.io/api/oidc"
  }
  expect_failures = [var.e2e_broker_issuer_url]
}

run "an_unpinned_workflow_ref_is_refused" {
  command = plan
  variables {
    e2e_broker_issuer_url    = "https://alethia-e2e-issuer.example.workers.dev"
    e2e_broker_workflow_refs = []
  }
  expect_failures = [google_iam_workload_identity_pool_provider.e2e_broker]
}

run "sharing_the_github_pool_is_reported" {
  command = plan
  variables {
    e2e_broker_issuer_url = "https://alethia-e2e-issuer.example.workers.dev"
    broker_pool_id        = "alethia-e2e-gh-pool"
  }
  expect_failures = [check.e2e_broker_trust_is_additive]
}
