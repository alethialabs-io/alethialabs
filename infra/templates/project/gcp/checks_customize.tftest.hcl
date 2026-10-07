# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# #5532 — the GCP CUSTOMIZABILITY-PARITY top gaps, proven against the PLAN.
#
#   cloud_sql_query_insights_enabled (+ _record_application_tags, _record_client_address)
#       → settings.insights_config on the Cloud SQL instance
#   cloud_storage_buckets[*].cmek_enabled
#       → a key in the project's key ring, a KEY-scoped grant to the Cloud Storage service agent,
#         and encryption.default_kms_key_name on the buckets that asked
#
# Cache logging has no knob: hashicorp/google 6.50.0 (the locked version) has no logging argument on
# google_redis_instance or google_memorystore_instance. That is recorded in CUSTOMIZABILITY-PARITY.md
# rather than declared as a variable nothing reads.
#
# Every assertion reads a PLANNED resource (or a module output read off one), never the variable
# that fed it. Each knob is asserted in both directions: the first run pins that a project setting
# none of them plans none of the new resources and no new block, which is the "defaults plan
# byte-identically" contract.
#
# `modules/**/*.tftest.hcl` is never executed by `tofu test` (root-level only), which is why this
# sits here. Providers are mocked, so this needs no credentials.

mock_provider "google" {
  # Cloud SQL's private_network reads the VPC self_link, and the provider parses it against a strict
  # pattern the generated mock string does not match.
  mock_resource "google_compute_network" {
    defaults = {
      self_link = "https://www.googleapis.com/compute/v1/projects/mock-project/global/networks/mock-vpc"
      id        = "projects/mock-project/global/networks/mock-vpc"
    }
  }

  # Asserted BY VALUE below: the bucket must carry this key's id, and the grant must name this key
  # and this agent.
  mock_resource "google_kms_crypto_key" {
    defaults = {
      id = "projects/mock-project/locations/europe-west3/keyRings/kms-mock/cryptoKeys/gcs-buckets"
    }
  }
  mock_resource "google_kms_key_ring" {
    defaults = {
      id = "projects/mock-project/locations/europe-west3/keyRings/kms-mock"
    }
  }
  mock_data "google_storage_project_service_account" {
    defaults = {
      email_address = "service-123456789@gs-project-accounts.iam.gserviceaccount.com"
    }
  }
  # The KMS API guard (secrets-encryption.tf) reads an EMPTY id as "API disabled" and fails closed.
  mock_data "google_project_service" {
    defaults = {
      id = "mock-project/cloudkms.googleapis.com"
    }
  }
}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "staging"
  project_name = "alethia"

  # Only the components the knobs attach to, so each default-off assertion is made where the knob
  # COULD have created something. These are the real variable names: tofu's test harness silently
  # ignores an undeclared one. provision_network stays ON (turning it off trips checks_network.tf).
  provision_gke               = false
  provision_artifact_registry = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_firestore            = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false

  create_cloud_sql     = true
  create_cloud_storage = true
  cloud_storage_buckets = [
    { name_suffix = "assets" },
    { name_suffix = "logs" },
  ]
}

################################################################################
# 0. Nothing set — no new block and no new resource
################################################################################

run "a_project_that_sets_no_knob_plans_none_of_them" {
  command = plan

  assert {
    condition     = length(module.cloud_sql[0].insights_config) == 0
    error_message = "With Query Insights unset (null) the instance must carry NO insights_config block — present-and-false would move the plan of every existing instance."
  }

  assert {
    condition     = alltrue([for k, v in module.cloud_storage[0].bucket_kms_key_names : v == null])
    error_message = "With no bucket asking for CMEK every bucket must keep Google-managed encryption (no encryption block)."
  }

  assert {
    condition = alltrue([
      length(google_kms_crypto_key.storage) == 0,
      length(google_kms_crypto_key_iam_member.storage) == 0,
      length(data.google_storage_project_service_account.gcs) == 0,
      length(google_kms_key_ring.gke_secrets) == 0,
      length(data.google_project_service.cloudkms) == 0,
    ])
    error_message = "A project that set no #5532 knob (and has no GKE) must plan no key ring, no key, no grant and no KMS API probe."
  }
}

################################################################################
# 1. Cloud SQL Query Insights
################################################################################

run "query_insights_on_sets_insights_config" {
  command = plan

  variables {
    cloud_sql_query_insights_enabled = true
  }

  assert {
    condition     = length(module.cloud_sql[0].insights_config) == 1 && module.cloud_sql[0].insights_config[0].query_insights_enabled == true
    error_message = "cloud_sql_query_insights_enabled = true must plan settings.insights_config with query_insights_enabled = true."
  }

  assert {
    condition     = module.cloud_sql[0].insights_config[0].record_application_tags == false && module.cloud_sql[0].insights_config[0].record_client_address == false
    error_message = "The record_* switches default to false and must stay false unless set."
  }
}

run "query_insights_record_switches_reach_the_block" {
  command = plan

  variables {
    cloud_sql_query_insights_enabled                 = true
    cloud_sql_query_insights_record_application_tags = true
    cloud_sql_query_insights_record_client_address   = true
  }

  assert {
    condition     = module.cloud_sql[0].insights_config[0].record_application_tags == true
    error_message = "cloud_sql_query_insights_record_application_tags must reach insights_config.record_application_tags."
  }

  assert {
    condition     = module.cloud_sql[0].insights_config[0].record_client_address == true
    error_message = "cloud_sql_query_insights_record_client_address must reach insights_config.record_client_address."
  }
}

# `insights_config` is Optional+Computed in hashicorp/google 6.50.0, so an ABSENT block keeps the
# state's value: once Query Insights is on, leaving the knob unset can never turn it off. false must
# therefore render the block, explicitly off — not collapse to "no block" like null does.
run "query_insights_false_renders_the_block_explicitly_off" {
  command = plan

  variables {
    cloud_sql_query_insights_enabled = false
  }

  assert {
    condition     = length(module.cloud_sql[0].insights_config) == 1
    error_message = "cloud_sql_query_insights_enabled = false must still plan an insights_config block: with the block absent the provider keeps the state's value, so turning Query Insights off would be a silent no-op."
  }

  assert {
    condition     = module.cloud_sql[0].insights_config[0].query_insights_enabled == false
    error_message = "cloud_sql_query_insights_enabled = false must plan insights_config.query_insights_enabled = false."
  }

  assert {
    condition     = module.cloud_sql[0].insights_config[0].record_application_tags == false && module.cloud_sql[0].insights_config[0].record_client_address == false
    error_message = "With Query Insights turned off both record_* switches must be planned false."
  }
}

# A record switch with insights unset has no block to live in. It is refused, not silently dropped.
run "a_record_switch_without_query_insights_is_refused" {
  command = plan

  variables {
    cloud_sql_query_insights_record_client_address = true
  }

  expect_failures = [terraform_data.cloud_sql_query_insights_guard]
}

# ...and with insights explicitly off Cloud SQL records nothing, so it is refused there too.
run "a_record_switch_with_query_insights_off_is_refused" {
  command = plan

  variables {
    cloud_sql_query_insights_enabled                 = false
    cloud_sql_query_insights_record_application_tags = true
  }

  expect_failures = [terraform_data.cloud_sql_query_insights_guard]
}

################################################################################
# 2. Bucket CMEK
################################################################################

run "cmek_on_one_bucket_encrypts_that_bucket_with_a_key_scoped_grant" {
  command = plan

  variables {
    cloud_storage_buckets = [
      { name_suffix = "assets", cmek_enabled = true },
      { name_suffix = "logs" },
    ]
  }

  assert {
    condition     = module.cloud_storage[0].bucket_kms_key_names["assets"] == google_kms_crypto_key.storage[0].id
    error_message = "The bucket that asked for CMEK must plan encryption.default_kms_key_name = the template's storage key."
  }

  assert {
    condition     = module.cloud_storage[0].bucket_kms_key_names["logs"] == null
    error_message = "A bucket that did not ask for CMEK must keep Google-managed encryption."
  }

  assert {
    condition     = length(google_kms_key_ring.gke_secrets) == 1 && google_kms_crypto_key.storage[0].key_ring == google_kms_key_ring.gke_secrets[0].id
    error_message = "With no GKE the key ring must still be created for the bucket key, and the key must live in it."
  }

  # The grant is on the ONE key (crypto_key_id = that key's id), to the Cloud Storage service agent,
  # with the encrypt/decrypt role only. The template declares no google_project_iam_* resource at
  # all; a project-scoped binding would 403 (#300) and reach every key in the project.
  assert {
    condition     = google_kms_crypto_key_iam_member.storage[0].crypto_key_id == google_kms_crypto_key.storage[0].id
    error_message = "The CMEK grant must be scoped to the bucket key itself."
  }

  assert {
    condition     = google_kms_crypto_key_iam_member.storage[0].role == "roles/cloudkms.cryptoKeyEncrypterDecrypter"
    error_message = "The CMEK grant must be roles/cloudkms.cryptoKeyEncrypterDecrypter and nothing wider."
  }

  assert {
    condition     = google_kms_crypto_key_iam_member.storage[0].member == "serviceAccount:service-123456789@gs-project-accounts.iam.gserviceaccount.com"
    error_message = "The CMEK grant must go to the Cloud Storage service agent."
  }
}

# The key ring is regional. A CMEK bucket placed elsewhere would be refused by Cloud Storage at
# apply, so it is refused at plan with the reason.
run "a_cmek_bucket_outside_the_key_region_is_refused" {
  command = plan

  variables {
    cloud_storage_buckets = [
      { name_suffix = "assets", cmek_enabled = true, location = "US" },
    ]
  }

  expect_failures = [terraform_data.storage_cmek_location_guard]
}

run "cmek_with_storage_off_creates_nothing" {
  command = plan

  variables {
    create_cloud_storage = false
    cloud_storage_buckets = [
      { name_suffix = "assets", cmek_enabled = true },
    ]
  }

  assert {
    condition     = length(google_kms_crypto_key.storage) == 0 && length(google_kms_crypto_key_iam_member.storage) == 0 && length(google_kms_key_ring.gke_secrets) == 0
    error_message = "With Cloud Storage off, a cmek_enabled entry must create no key, no grant and no ring."
  }
}
