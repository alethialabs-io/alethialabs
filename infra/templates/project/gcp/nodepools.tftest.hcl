# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# GKE node labels, node taints and extra node pools (#5537), proven against the PLAN.
#
# The contract's own cases (every refusal, and the render) are in nodepool_contract.tftest.hcl.
# This file asserts what GKE builds from them: one google_container_node_pool per pool, keyed by
# name, with its own machine type, Spot, sizes, labels and GKE-spelled taints; the isolation every
# extra pool shares with the default pool; and what checks_nodepools.tf refuses.
#
# HOW A CLUSTER IS PLANNED HERE AT ALL. modules/gke cannot be planned under mocked providers (its
# computed-only `master_auth` block; checks_cluster_optional.tftest.hcl records the finding), so the
# module is replaced by `override_module` with the outputs the root reads. That is why the extra
# pools are root resources (nodepools.tf): every assertion below reads a PLANNED pool. What this
# cannot reach is the default pool inside the module. Its one new input, node_labels, is asserted
# at the root (`local.nodepool_contract_render["default"].labels`), and the module renders
# local.merged_labels unchanged when that input is empty (modules/gke/main.tf).
#
# Providers are mocked, so this needs no credentials.

mock_provider "google" {
  # Cloud SQL's private_network reads the VPC self_link, which the provider parses.
  mock_resource "google_compute_network" {
    defaults = {
      self_link = "https://www.googleapis.com/compute/v1/projects/mock-project/global/networks/mock-vpc"
      id        = "projects/mock-project/global/networks/mock-vpc"
    }
  }

  # The Workload Identity bindings (workload-identity.tf) pass a service account's `name` as
  # service_account_id, which the provider parses. Not under test; it must merely parse.
  mock_resource "google_service_account" {
    defaults = {
      name  = "projects/mock-project/serviceAccounts/mock-sa@mock-project.iam.gserviceaccount.com"
      email = "mock-sa@mock-project.iam.gserviceaccount.com"
    }
  }
  mock_data "google_service_account" {
    defaults = {
      name  = "projects/mock-project/serviceAccounts/mock-sa@mock-project.iam.gserviceaccount.com"
      email = "mock-sa@mock-project.iam.gserviceaccount.com"
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

# The GKE module, replaced by the outputs the root reads (see the header).
override_module {
  target = module.gke
  outputs = {
    cluster_name           = "gke-ew3-production-alethia"
    cluster_endpoint       = "10.0.0.1"
    cluster_ca_certificate = "bW9jaw=="
    cluster_id             = "projects/mock-project/locations/europe-west3/clusters/gke-ew3-production-alethia"
    node_pool_name         = "gke-ew3-production-alethia-default-pool"
  }
}

variables {
  project_id    = "mock-project"
  region        = "europe-west3"
  environment   = "production"
  project_name  = "alethia"
  provision_gke = true
}

################################################################################
# 1. Nothing set — the plan is the one before #5537
################################################################################

# The load-bearing run. A project that sets none of the three variables must plan no extra pool and
# no guard, and must hand the GKE module an empty node_labels, which the module renders as the
# default pool's labels unchanged.
run "nodepools_defaults_plan_exactly_as_before" {
  command = plan

  assert {
    condition     = length(google_container_node_pool.extra) == 0
    error_message = "With no extra_node_pools there must be no google_container_node_pool.extra."
  }

  assert {
    condition     = length(terraform_data.gke_nodepool_guard) == 0
    error_message = "With none of the three variables set, terraform_data.gke_nodepool_guard must not exist: it would be a new resource in every existing project's plan."
  }

  assert {
    condition     = jsonencode(local.nodepool_contract_render["default"].labels) == jsonencode({})
    error_message = "With no node_labels the GKE module's node_labels input must be empty, which renders the default pool's labels exactly as before."
  }
}

################################################################################
# 2. Labels, taints, sizes and Spot on the planned pools
################################################################################

# Two pools: an arm64 Spot batch pool and an amd64 GPU pool, with a node label, a node taint, and
# each pool's own labels and taints.
run "nodepools_two_pools_carry_their_own_shape" {
  command = plan

  variables {
    node_labels = {
      team = "payments"
    }
    node_taints = [
      { key = "dedicated", value = "batch", effect = "NoSchedule" },
    ]
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "t2a-standard-4"
        arch          = "arm64"
        capacity_type = "spot"
        min_size      = 0
        max_size      = 6
        desired_size  = 3
        labels        = { workload = "batch" }
        taints = [
          { key = "example.com/batch", effect = "PreferNoSchedule" },
        ]
      },
      {
        name          = "gpu"
        instance_type = "g2-standard-4"
        min_size      = 1
        max_size      = 3
        taints = [
          { key = "gpu", value = "true", effect = "NoExecute" },
        ]
      },
    ]
  }

  assert {
    condition     = toset(keys(google_container_node_pool.extra)) == toset(["batch", "gpu"])
    error_message = "Each extra_node_pools entry must be one google_container_node_pool, keyed by its name."
  }

  assert {
    condition = alltrue([
      google_container_node_pool.extra["batch"].name == "gke-ew3-production-alethia-batch",
      google_container_node_pool.extra["gpu"].name == "gke-ew3-production-alethia-gpu",
      google_container_node_pool.extra["batch"].cluster == "gke-ew3-production-alethia",
      google_container_node_pool.extra["batch"].location == "europe-west3",
      google_container_node_pool.extra["batch"].project == "mock-project",
    ])
    error_message = "An extra pool must be named <cluster name>-<pool name> and belong to the template's cluster."
  }

  assert {
    condition = alltrue([
      google_container_node_pool.extra["batch"].node_config[0].machine_type == "t2a-standard-4",
      google_container_node_pool.extra["gpu"].node_config[0].machine_type == "g2-standard-4",
      google_container_node_pool.extra["batch"].node_config[0].spot == true,
      google_container_node_pool.extra["gpu"].node_config[0].spot == false,
    ])
    error_message = "instance_type must be the pool's machine_type, and capacity_type spot must be node_config.spot."
  }

  # Sizes bound the whole pool. A regional cluster (europe-west3) has three zones and
  # initial_node_count is per zone: desired 3 starts one per zone; the GPU pool's desired (= min 1)
  # rounds up to one per zone, which is 3 nodes, inside [1, 3].
  assert {
    condition = alltrue([
      google_container_node_pool.extra["batch"].autoscaling[0].total_min_node_count == 0,
      google_container_node_pool.extra["batch"].autoscaling[0].total_max_node_count == 6,
      google_container_node_pool.extra["gpu"].autoscaling[0].total_min_node_count == 1,
      google_container_node_pool.extra["gpu"].autoscaling[0].total_max_node_count == 3,
      google_container_node_pool.extra["batch"].initial_node_count == 1,
      google_container_node_pool.extra["gpu"].initial_node_count == 1,
      google_container_node_pool.extra["batch"].autoscaling[0].location_policy == "ANY",
      google_container_node_pool.extra["gpu"].autoscaling[0].location_policy == "BALANCED",
    ])
    error_message = "Each pool must autoscale between its own min_size and max_size in total, starting from desired_size spread over the zones."
  }

  # node_labels and the pool's labels on top of the labels every node of this template carries, and
  # the platform's alethia.io/pool.
  assert {
    condition = google_container_node_pool.extra["batch"].node_config[0].labels == tomap({
      environment       = "production"
      service           = "alethia"
      managed-by        = "opentofu"
      team              = "payments"
      workload          = "batch"
      "alethia.io/pool" = "batch"
    })
    error_message = "The batch pool's node labels must be the template's labels, node_labels, its own labels and alethia.io/pool=batch."
  }

  assert {
    condition = google_container_node_pool.extra["gpu"].node_config[0].labels == tomap({
      environment       = "production"
      service           = "alethia"
      managed-by        = "opentofu"
      team              = "payments"
      "alethia.io/pool" = "gpu"
    })
    error_message = "node_labels must reach every extra pool."
  }

  assert {
    condition     = jsonencode(local.nodepool_contract_render["default"].labels) == jsonencode({ team = "payments" })
    error_message = "node_labels must reach the default pool, through the GKE module's node_labels input."
  }

  # Effects in the GKE API's spelling; the node taint, the pool's own, then the arm64 platform taint.
  assert {
    condition = jsonencode([for t in google_container_node_pool.extra["batch"].node_config[0].taint : { key = t.key, value = t.value, effect = t.effect }]) == jsonencode([
      { key = "dedicated", value = "batch", effect = "NO_SCHEDULE" },
      { key = "example.com/batch", value = "", effect = "PREFER_NO_SCHEDULE" },
      { key = "alethia.io/arch", value = "arm64", effect = "NO_SCHEDULE" },
    ])
    error_message = "The batch pool's taints must be node_taints, its own taints and alethia.io/arch=arm64, with GKE's effect names."
  }

  assert {
    condition = jsonencode([for t in google_container_node_pool.extra["gpu"].node_config[0].taint : { key = t.key, value = t.value, effect = t.effect }]) == jsonencode([
      { key = "dedicated", value = "batch", effect = "NO_SCHEDULE" },
      { key = "gpu", value = "true", effect = "NO_EXECUTE" },
    ])
    error_message = "The GPU pool must carry node_taints and its own NoExecute taint as NO_EXECUTE, and no arm64 taint."
  }
}

# A zonal cluster has one zone, so a pool starts with desired_size nodes.
run "nodepools_zonal_cluster_starts_at_desired_size" {
  command = plan

  variables {
    region = "europe-west3-a"
    extra_node_pools = [
      { name = "batch", instance_type = "e2-standard-4", min_size = 1, max_size = 5, desired_size = 2 },
    ]
  }

  assert {
    condition     = google_container_node_pool.extra["batch"].initial_node_count == 2 && google_container_node_pool.extra["batch"].location == "europe-west3-a"
    error_message = "On a zonal cluster the pool must start with desired_size nodes."
  }
}

# A regional pool starts inside [min_size, max_size] whenever a multiple of three lies in it:
# min 4 / max 6 and min 4 / max 9 (desired 4) both round up to two per zone, 6 nodes.
run "nodepools_regional_pool_starts_inside_min_and_max" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "web", instance_type = "e2-standard-4", min_size = 4, max_size = 6, desired_size = 4 },
      { name = "api", instance_type = "e2-standard-4", min_size = 4, max_size = 9, desired_size = 4 },
    ]
  }

  assert {
    condition = alltrue([
      google_container_node_pool.extra["web"].initial_node_count == 2,
      google_container_node_pool.extra["api"].initial_node_count == 2,
    ])
    error_message = "A regional pool must start with at least min_size and at most max_size nodes in total (per-zone count x 3)."
  }
}

# min 4 / max 5 holds no multiple of three, so no even start fits. The pool starts on 6 (over
# max_size, never under min_size), and the plan still succeeds.
run "nodepools_regional_pool_with_no_even_start_starts_over_max" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "web", instance_type = "e2-standard-4", min_size = 4, max_size = 5 },
    ]
  }

  assert {
    condition     = google_container_node_pool.extra["web"].initial_node_count == 2
    error_message = "With no multiple of three in [min_size, max_size], a regional pool must start above max_size rather than under min_size."
  }
}

# On a zonal cluster the same pool starts at exactly min_size.
run "nodepools_zonal_pool_with_the_same_range_starts_at_min_size" {
  command = plan

  variables {
    region = "europe-west3-a"
    extra_node_pools = [
      { name = "web", instance_type = "e2-standard-4", min_size = 4, max_size = 5 },
    ]
  }

  assert {
    condition     = google_container_node_pool.extra["web"].initial_node_count == 4
    error_message = "On a zonal cluster a pool must start with desired_size (here min_size) nodes."
  }
}

# The pool name goes through the default pool's length-and-hash rule (checks_naming.tf), so a long
# cluster name cannot push it past GKE's 40-character limit. 39 characters keeps the readable form;
# 40 falls back to 31 characters, "-" and 7 hex of the full name's digest.
run "nodepools_long_names_keep_under_the_gke_limit" {
  command = plan

  variables {
    project_name = "alethiax"
    extra_node_pools = [
      { name = "batchworkers", instance_type = "e2-standard-4", min_size = 0, max_size = 1 },
      { name = "web", instance_type = "e2-standard-4", min_size = 0, max_size = 1 },
    ]
  }

  assert {
    condition     = google_container_node_pool.extra["batchworkers"].name == "gke-ew3-production-alethiax-bat-41c88b9"
    error_message = "A 40-character pool name must fall back to truncate-plus-digest, got ${google_container_node_pool.extra["batchworkers"].name}."
  }

  assert {
    condition     = google_container_node_pool.extra["web"].name == "gke-ew3-production-alethiax-web"
    error_message = "A pool name that fits must keep the readable form."
  }
}

run "nodepools_39_char_name_stays_readable" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batchworkers", instance_type = "e2-standard-4", min_size = 0, max_size = 1 },
    ]
  }

  assert {
    condition     = google_container_node_pool.extra["batchworkers"].name == "gke-ew3-production-alethia-batchworkers"
    error_message = "A 39-character pool name must keep the readable form."
  }
}

################################################################################
# 3. Isolation parity (security, #5537 item 4)
################################################################################

# Every extra pool carries the default pool's isolation: the GKE metadata server (without it a pod
# reads the node's credentials from the metadata endpoint), shielded nodes, legacy metadata
# endpoints off, the same OAuth scope, the same node service account (none set: the project's
# Compute Engine default, as on the default pool) and the same boot disk.
run "nodepools_every_pool_keeps_the_default_pools_isolation" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "spotty", instance_type = "e2-standard-4", capacity_type = "spot", min_size = 0, max_size = 3 },
      { name = "arm", instance_type = "c4a-standard-8", arch = "arm64", min_size = 0, max_size = 3 },
    ]
  }

  assert {
    condition     = alltrue([for p in google_container_node_pool.extra : p.node_config[0].workload_metadata_config[0].mode == "GKE_METADATA"])
    error_message = "Every extra pool must run the GKE metadata server (workload_metadata_config.mode = GKE_METADATA); without it a pod can read the node's credentials from the metadata server."
  }

  assert {
    condition = alltrue([for p in google_container_node_pool.extra :
      p.node_config[0].shielded_instance_config[0].enable_secure_boot == true &&
      p.node_config[0].shielded_instance_config[0].enable_integrity_monitoring == true
    ])
    error_message = "Every extra pool must be a shielded node pool with secure boot and integrity monitoring, as the default pool is."
  }

  assert {
    condition = alltrue([for p in google_container_node_pool.extra :
      p.node_config[0].metadata["disable-legacy-endpoints"] == "true" &&
      tolist(p.node_config[0].oauth_scopes) == tolist(["https://www.googleapis.com/auth/cloud-platform"])
    ])
    error_message = "Every extra pool must disable the legacy metadata endpoints and use the default pool's OAuth scope."
  }

  assert {
    condition = alltrue([for p in google_container_node_pool.extra :
      p.node_config[0].disk_size_gb == 50 && p.node_config[0].disk_type == "pd-standard" &&
      length(p.node_config[0].boot_disk) == 0 &&
      p.node_config[0].boot_disk_kms_key == null
    ])
    error_message = "Every extra pool must use the default pool's boot disk (gke_disk_size_gb, gke_disk_type) and its encryption."
  }

  assert {
    condition = alltrue([for p in google_container_node_pool.extra :
      p.management[0].auto_repair == true && p.management[0].auto_upgrade == true
    ])
    error_message = "Every extra pool must auto-repair and auto-upgrade, as the default pool does."
  }
}

# Provisioned boot-disk performance reaches the extra pools the way it reaches the default pool:
# the nested boot_disk block replaces the flat pair.
run "nodepools_boot_disk_performance_reaches_every_pool" {
  command = plan

  variables {
    gke_disk_type   = "hyperdisk-balanced"
    gke_volume_iops = 3000
    extra_node_pools = [
      { name = "batch", instance_type = "c4a-standard-8", arch = "arm64", min_size = 0, max_size = 3 },
    ]
  }

  assert {
    condition = alltrue([
      google_container_node_pool.extra["batch"].node_config[0].boot_disk[0].disk_type == "hyperdisk-balanced",
      google_container_node_pool.extra["batch"].node_config[0].boot_disk[0].provisioned_iops == 3000,
    ])
    error_message = "With gke_volume_iops set, an extra pool must render the boot_disk block, as the default pool does."
  }
}

################################################################################
# 4. What GKE refuses (checks_nodepools.tf)
################################################################################

run "nodepools_refuses_extra_pools_on_autopilot" {
  command = plan

  variables {
    gke_enable_autopilot = true
    extra_node_pools = [
      { name = "batch", instance_type = "e2-standard-4", min_size = 0, max_size = 3 },
    ]
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

run "nodepools_refuses_node_labels_on_autopilot" {
  command = plan

  variables {
    gke_enable_autopilot = true
    node_labels          = { team = "payments" }
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

run "nodepools_refuses_settings_without_a_cluster" {
  command = plan

  variables {
    provision_gke = false
    node_labels   = { team = "payments" }
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

# A4X / A4X Max run on NVIDIA Grace, an Arm CPU (nodekeys.GCPArmMachineFamilies): an arm64 pool on
# them plans, and an amd64 pool on them is refused.
run "nodepools_accepts_arm64_on_a4x" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "gb200", instance_type = "a4x-highgpu-4g", arch = "arm64", min_size = 0, max_size = 3 },
      { name = "gb300", instance_type = "a4x-maxgpu-4g-metal", arch = "arm64", min_size = 0, max_size = 3 },
    ]
  }

  assert {
    condition = alltrue([for p in google_container_node_pool.extra :
      contains([for t in p.node_config[0].taint : "${t.key}=${t.value}:${t.effect}"], "alethia.io/arch=arm64:NO_SCHEDULE")
    ])
    error_message = "An arm64 pool on A4X must plan and carry the alethia.io/arch=arm64 taint."
  }
}

run "nodepools_refuses_amd64_on_a4x" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "gb200", instance_type = "a4x-highgpu-4g", min_size = 0, max_size = 3 },
    ]
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

run "nodepools_refuses_an_instance_type_from_another_cloud" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batch", instance_type = "Standard_D4s_v5", min_size = 0, max_size = 3 },
    ]
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

run "nodepools_refuses_arm64_on_an_x86_machine" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batch", instance_type = "e2-standard-4", arch = "arm64", min_size = 0, max_size = 3 },
    ]
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

run "nodepools_refuses_amd64_on_an_arm_machine" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batch", instance_type = "t2a-standard-4", min_size = 0, max_size = 3 },
    ]
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

run "nodepools_refuses_a_node_label_the_template_sets" {
  command = plan

  variables {
    node_labels = { environment = "dev" }
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}

run "nodepools_refuses_a_pool_label_the_template_sets" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batch", instance_type = "e2-standard-4", min_size = 0, max_size = 3, labels = { managed-by = "me" } },
    ]
  }

  expect_failures = [terraform_data.gke_nodepool_guard]
}
