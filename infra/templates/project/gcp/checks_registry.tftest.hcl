# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the canvas's "Immutable tags" switch reaches the Artifact Registry RESOURCE, and that
# the two positions of the switch plan DIFFERENTLY.
#
# Two things this exists to catch, neither of which any static check can:
#
#   1. WIRING IS NOT BEHAVIOUR. The offer-parity guard asks "does a resource argument read this
#      name". It cannot ask whether that argument implements what the canvas label promises, and it
#      cannot ask whether the OFF position does anything at all. A template that hardcoded
#      `immutable_tags = true` would satisfy the guard and pass any test that only asserted the
#      enabled case. So both runs below assert a VALUE, and they assert opposite ones.
#
#   2. THE MODULE BOUNDARY. `format` was declared on the root's `artifact_registry_repos` and never
#      named by the module's own object type, so tofu's type conversion discarded it silently and
#      main.tf hardcoded DOCKER regardless — a knob that read as configurable and was not. The same
#      thing happened to cloud-storage's `uniform_access`. The assertions read
#      `repository_immutable_tags`, which is projected off `google_artifact_registry_repository`
#      itself, so a value dropped at that boundary fails here instead of shipping.
#
# This file is at the ROOT on purpose: `modules/**/*.tftest.hcl` is silently never executed.
#
# Providers are mocked and every provisionable component is off, so this needs no credentials.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia"

  # Artifact Registry is the subject; everything else is off. These are the REAL variable names —
  # tofu silently IGNORES an undeclared one, which is how checks_naming.tftest.hcl spent months
  # asserting far less than it claimed.
  provision_gke             = false
  create_cloud_sql          = false
  create_memorystore        = false
  create_memorystore_valkey = false
  create_pubsub             = false
  create_firestore          = false
  create_cloud_storage      = false
  cloud_dns_enabled         = false
  cloud_armor_enabled       = false

  provision_artifact_registry = true
}

# ON. `docker_config.immutable_tags` must plan true.
run "immutable_tags_on_reaches_the_repository" {
  command = plan

  variables {
    artifact_registry_repos = {
      apps = { description = "Container images for apps", immutable_tags = true }
    }
  }

  assert {
    condition     = module.artifact_registry[0].repository_immutable_tags["apps"] == true
    error_message = "immutable_tags = true was not planned onto google_artifact_registry_repository.docker_config; got ${jsonencode(module.artifact_registry[0].repository_immutable_tags)}."
  }
}

# OFF, and this is the half that matters. Without it a template that hardcoded immutability on —
# which is what this module did for every repository it could have created before #1835 gave it any
# — would pass the run above and this whole file would prove nothing.
run "immutable_tags_off_reaches_the_repository" {
  command = plan

  variables {
    artifact_registry_repos = {
      apps = { description = "Container images for apps", immutable_tags = false }
    }
  }

  assert {
    condition     = module.artifact_registry[0].repository_immutable_tags["apps"] == false
    error_message = "immutable_tags = false was ignored — the switch's OFF position must plan differently from its ON position, or the repository is immutable no matter what the user chose. Got ${jsonencode(module.artifact_registry[0].repository_immutable_tags)}."
  }
}

# An omitted switch must take the SAFE setting, not `false`. This is the upgrade path: a snapshot
# written before #1811 carries no value, and defaulting it off would turn tag immutability off on
# every repository a live project already has, with nobody having touched a switch.
run "an_omitted_switch_defaults_to_immutable" {
  command = plan

  variables {
    artifact_registry_repos = {
      apps = {}
    }
  }

  assert {
    condition     = module.artifact_registry[0].repository_immutable_tags["apps"] == true
    error_message = "A repository configured with no immutable_tags value must default to IMMUTABLE — the safe setting, and the one every repository built so far already has. Got ${jsonencode(module.artifact_registry[0].repository_immutable_tags)}."
  }
}

# #1835 from the other side: `provision_artifact_registry` used to be true whenever a registry row
# existed while `artifact_registry_repos` was emitted by nothing, so the module's for_each resolved
# to {} and GCP created ZERO repositories behind a flag that read "provisioned". The check block
# refuses that shape; without this run nobody would ever have seen it refuse.
run "provisioning_with_no_repositories_is_refused" {
  command = plan

  variables {
    artifact_registry_repos = {}
  }

  expect_failures = [check.artifact_registry_repos_present_when_provisioned]
}

# The map key becomes part of the repository id, which Google requires to be lowercase letters,
# numbers and hyphens. The emitter deliberately does not normalise it (it is also the lookup key of
# the URL output), so the template has to refuse a bad one rather than rename it mid-apply.
run "an_illegal_repository_name_is_refused" {
  command = plan

  variables {
    artifact_registry_repos = {
      "Apps_Prod" = { description = "bad name" }
    }
  }

  expect_failures = [check.artifact_registry_repo_names_valid]
}
