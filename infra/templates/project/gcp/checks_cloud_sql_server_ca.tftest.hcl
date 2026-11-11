# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The Cloud SQL server CA outputs the database bootstrap Jobs verify the server against (#6521).
#
# Why this file runs APPLY and not plan: the google provider marks the instance's `server_ca_cert`
# sensitive, and OpenTofu refuses a root output that carries a sensitive value unless the output is
# itself `sensitive = true`. In a plan, the attribute of a new instance is unknown, so the refusal
# never fires and every plan-mode run in this directory stays green over a root output that fails
# the real apply of every GCP project with Cloud SQL. Here the mocked instance returns a KNOWN CA, so
# the refusal fires exactly as a real apply does. Mutation-checked: removing `sensitive = true` from
# `cloud_sql_server_ca_cert` in outputs.tf turns `the_server_ca_reaches_the_root_outputs` red.
#
# `sensitive` only stops OpenTofu printing the value. `tofu output -json` still carries it, and the
# runner reads it there (packages/core/tofu TofuCLI.Output; pinned by
# TestOutput_ReturnsASensitivePEMOutputVerbatim). A CA certificate is public, so the runner's
# persisted-metadata scrub keeps it too.
#
# Providers are mocked and the cluster stays off, so this needs no credentials.

mock_provider "google" {
  mock_resource "google_compute_network" {
    defaults = {
      self_link = "https://www.googleapis.com/compute/v1/projects/mock-project/global/networks/mock-vpc"
      id        = "projects/mock-project/global/networks/mock-vpc"
    }
  }
  # A KNOWN server CA (a test value, not a real certificate) and the per-instance CA mode, as the
  # API reports them for an instance the template creates.
  mock_resource "google_sql_database_instance" {
    defaults = {
      server_ca_cert = [{
        cert             = "-----BEGIN CERTIFICATE-----\nTEST-CLOUD-SQL-SERVER-CA\n-----END CERTIFICATE-----\n"
        common_name      = "C=US,O=Google\\, Inc,CN=Google Cloud SQL Server CA,dnQualifier=mock"
        create_time      = "2026-01-01T00:00:00Z"
        expiration_time  = "2036-01-01T00:00:00Z"
        sha1_fingerprint = "0000000000000000000000000000000000000000"
      }]
    }
  }
}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia-nl"

  provision_gke    = false
  create_cloud_sql = true

  provision_artifact_registry = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_firestore            = false
  create_cloud_storage        = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false
}

run "the_server_ca_reaches_the_root_outputs" {
  command = apply

  assert {
    condition     = output.cloud_sql_server_ca_cert == "-----BEGIN CERTIFICATE-----\nTEST-CLOUD-SQL-SERVER-CA\n-----END CERTIFICATE-----\n"
    error_message = "cloud_sql_server_ca_cert is not the instance's server CA, verbatim."
  }
}

# Without Cloud SQL there is no CA, and both outputs are null rather than an error, so a project
# without a database still applies.
run "no_cloud_sql_means_no_server_ca" {
  command = apply

  variables {
    create_cloud_sql = false
  }

  assert {
    condition     = output.cloud_sql_server_ca_cert == null && output.cloud_sql_server_ca_mode == null
    error_message = "a project without Cloud SQL must emit null server CA outputs."
  }
}
