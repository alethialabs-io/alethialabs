# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the canvas's `public_access` switch changes the PLAN, in both directions, and that it
# changes the thing it claims to change.
#
# The carrier probe (#1419) can only ask "does a resource argument read this name". It cannot ask
# whether that argument implements the feature the label promises — which is exactly how this cell
# was broken: the provider sent `uniform_access`, a real argument about per-object ACLs that has
# nothing to do with public readability, and the module then hardcoded the value it wanted anyway.
# A wiring check goes green on that. Only a plan does not.
#
# Both directions are asserted deliberately. A suite that only exercised the ON case would pass for
# a template that hardcoded public access on, which is the mirror image of the bug being fixed.
#
# Providers are mocked and only Cloud Storage is switched on, so this needs no credentials.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia"

  # Everything except Cloud Storage is off. provision_network stays ON: turning it off makes
  # checks_network.tf's brownfield guard demand an external subnetwork, which would block the plan
  # for a reason unrelated to storage.
  provision_gke               = false
  provision_artifact_registry = false
  create_cloud_sql            = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_pubsub               = false
  create_firestore            = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false

  create_cloud_storage = true
}

################################################################################
# 1. The switch OFF — the state every existing bucket is already in
################################################################################

run "a_private_bucket_enforces_prevention_and_grants_nobody" {
  command = plan

  variables {
    cloud_storage_buckets = [
      { name_suffix = "assets", public_access = false },
    ]
  }

  assert {
    condition     = output.cloud_storage_public_access_prevention["assets"] == "enforced"
    error_message = "A bucket with public_access = false must plan public_access_prevention = \"enforced\", got ${output.cloud_storage_public_access_prevention["assets"]}."
  }

  # The half that is easy to forget. Prevention is only about whether a grant is PERMITTED; without
  # this assertion a template that always granted allUsers would still pass the line above.
  assert {
    condition     = length(output.cloud_storage_publicly_readable_buckets) == 0
    error_message = "A private bucket must carry no allUsers binding, got ${jsonencode(output.cloud_storage_publicly_readable_buckets)}."
  }
}

################################################################################
# 2. The switch ON — and BOTH halves of it
################################################################################

run "a_public_bucket_inherits_prevention_and_grants_allusers" {
  command = plan

  variables {
    cloud_storage_buckets = [
      { name_suffix = "assets", public_access = true },
    ]
  }

  # Half one: stop refusing. "inherited" defers to the organization policy rather than blocking
  # outright — it is NOT a grant, which is what the next assertion is for.
  assert {
    condition     = output.cloud_storage_public_access_prevention["assets"] == "inherited"
    error_message = "A bucket with public_access = true must plan public_access_prevention = \"inherited\", got ${output.cloud_storage_public_access_prevention["assets"]}."
  }

  # Half two: actually grant. Without this the switch would be carried, read, and completely inert —
  # the plan would show a changed bucket and no object would become readable by anyone.
  assert {
    condition     = join(",", output.cloud_storage_publicly_readable_buckets) == "assets"
    error_message = "A public bucket must carry an allUsers reader binding, got ${jsonencode(output.cloud_storage_publicly_readable_buckets)}."
  }
}

################################################################################
# 3. The switch is per bucket, not per project
################################################################################

# The aggregation mistake this template must not make: one public bucket must not open the others.
# Cheap to assert, and it is the failure mode a "simplify it to one flag" refactor would introduce.
run "public_access_is_decided_per_bucket" {
  command = plan

  variables {
    cloud_storage_buckets = [
      { name_suffix = "assets", public_access = true },
      { name_suffix = "backups", public_access = false },
    ]
  }

  assert {
    condition = alltrue([
      output.cloud_storage_public_access_prevention["assets"] == "inherited",
      output.cloud_storage_public_access_prevention["backups"] == "enforced",
      join(",", output.cloud_storage_publicly_readable_buckets) == "assets",
    ])
    error_message = "Each bucket must get its own answer; got ${jsonencode(output.cloud_storage_public_access_prevention)} / ${jsonencode(output.cloud_storage_publicly_readable_buckets)}."
  }
}
