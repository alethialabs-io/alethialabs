# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof for the ACK node-shape knobs (system-disk category/performance, interruptible capacity) and
# the four gates in checks_cluster.tf.
#
# Every run plans a REAL cluster (provision_ack = true), which the GCP template cannot do under
# mocks — so the assertions read the PLANNED NODE POOL, through modules/cluster's verification
# outputs, rather than the root locals that feed it.
#
# That distinction is the whole reason those outputs exist. The two disk-performance figures are
# resolved against the disk category in the root's locals.tf, and a local-based assertion proves
# only the DECISION: delete `system_disk_provisioned_iops = var.disk_provisioned_iops` from the node
# pool and every such assertion still passes, because the value was still computed — it simply
# stopped reaching the resource. "Declared, derived, and read by nothing" is the unwired-template
# defect this pass exists to end, so the tests must not be blind to it.
#
# The alicloud mock is copied from checks_secrets.tftest.hcl; its three entries are load-bearing and
# the comments there record why (empty computed lists break element(); the ACK resource validates
# vswitch id FORMAT before any API call; rrsa_metadata is a computed nested block the outputs read).

mock_provider "alicloud" {
  # ACK's create API resolves a ROS component by EXACT version string, so ack-version.tf resolves the
  # declared MINOR against what the region offers. Same trap the alicloud_zones mock above documents:
  # the mock's default for a computed LIST is an EMPTY list, so without this every plan fails the
  # terraform_data.ack_version_resolvable precondition — which is the guard doing its job, not a bug.
  # The patch numbers are the ones eu-central-1 actually offered on 2026-08-25.
  mock_data "alicloud_cs_kubernetes_version" {
    defaults = {
      metadata = [
        { version = "1.36.2-aliyun.1", runtime = [] },
        { version = "1.35.7-aliyun.1", runtime = [] },
        { version = "1.34.10-aliyun.1", runtime = [] },
      ]
    }
  }

  mock_data "alicloud_zones" {
    defaults = {
      zones = [
        {
          id                          = "eu-central-1a"
          local_name                  = "eu-central-1a"
          available_disk_categories   = ["cloud_essd"]
          available_instance_types    = ["ecs.g6.large"]
          available_resource_creation = ["VSwitch"]
          multi_zone_ids              = []
          slb_slave_zone_ids          = []
        },
        {
          id                          = "eu-central-1b"
          local_name                  = "eu-central-1b"
          available_disk_categories   = ["cloud_essd"]
          available_instance_types    = ["ecs.g6.large"]
          available_resource_creation = ["VSwitch"]
          multi_zone_ids              = []
          slb_slave_zone_ids          = []
        },
      ]
    }
  }

  mock_resource "alicloud_vswitch" {
    defaults = {
      id = "vsw-0123456789abcdefghijklmn"
    }
  }

  mock_resource "alicloud_cs_managed_kubernetes" {
    defaults = {
      rrsa_metadata = [{
        enabled                = true
        rrsa_oidc_issuer_url   = "https://oidc-ack-eu-central-1.oss-eu-central-1.aliyuncs.com/cluster/mock"
        ram_oidc_provider_arn  = "acs:ram::100000000000000:oidc-provider/ack-rrsa-mock"
        ram_oidc_provider_name = "ack-rrsa-mock"
      }]
    }
  }
}

mock_provider "random" {}

variables {
  project_name = "alethia-nl"
  region       = "eu-central-1"
  environment  = "production"

  provision_ack = true
}

################################################################################
# 1. The default node pool is unchanged
################################################################################

# THE run this whole change is answerable to. Five new variables reached the node pool; a project
# that set none of them must plan the resource it planned before. `cloud_essd` was a literal in
# modules/cluster/main.tf, so the default is not a preference — it is the old value, and if this
# assertion ever fails the change stopped being additive.
run "a_project_that_sets_nothing_gets_the_node_pool_it_had" {
  command = plan

  assert {
    condition     = var.ack_disk_category == "cloud_essd"
    error_message = "The default system disk category must remain cloud_essd — the literal this module carried before ack_disk_category existed."
  }

  assert {
    condition     = module.cluster[0].node_pool_system_disk_category == "cloud_essd"
    error_message = "The node pool must still be PLANNED with cloud_essd — the literal this module carried before ack_disk_category existed."
  }

  assert {
    condition     = module.cluster[0].node_pool_system_disk_performance_level == null
    error_message = "With ack_disk_performance_level unset the node pool must carry no performance level — not an empty string, and not a PL0 that would re-tier an existing disk."
  }

  assert {
    condition     = module.cluster[0].node_pool_system_disk_provisioned_iops == null
    error_message = "With ack_disk_provisioned_iops unset the node pool must carry no provisioned IOPS."
  }

  assert {
    condition     = module.cluster[0].node_pool_spot_strategy == "NoSpot"
    error_message = "The node pool must still be planned on-demand."
  }

  assert {
    condition     = var.ack_node_capacity_type == "NoSpot"
    error_message = "The default bidding strategy must be NoSpot — the ACK API's own name for on-demand, which is what an unset spot_strategy resolves to."
  }

  assert {
    condition     = length(local.ack_spot_price_limits) == 0
    error_message = "An on-demand node pool must render NO spot_price_limit block at all."
  }
}

################################################################################
# 2. Each knob actually reaches the node pool
################################################################################

# A performance LEVEL is an integer in the template and a "PL<n>" string in the API. The rendering
# is the thing under test: a variable that arrives as 2 and leaves as 2 would be rejected at apply.
run "an_essd_performance_level_is_rendered_as_a_PL_string" {
  command = plan

  variables {
    ack_disk_category          = "cloud_essd"
    ack_disk_performance_level = 2
  }

  assert {
    condition     = module.cluster[0].node_pool_system_disk_performance_level == "PL2"
    error_message = "ack_disk_performance_level = 2 must ARRIVE ON THE NODE POOL as \"PL2\" — the API takes the string form, not the integer. Read off the planned resource, not off the local, so that deleting the assignment fails here."
  }

  # The other argument must stay OFF. Both figures rendered at once is the shape the API drops one
  # half of, and the root's category ternaries are what prevent it.
  assert {
    condition     = module.cluster[0].node_pool_system_disk_provisioned_iops == null
    error_message = "An ESSD pool must send no provisioned IOPS — that argument belongs to cloud_auto."
  }
}

run "provisioned_iops_reaches_a_cloud_auto_node_pool" {
  command = plan

  variables {
    ack_disk_category         = "cloud_auto"
    ack_disk_provisioned_iops = 6000
  }

  assert {
    condition     = module.cluster[0].node_pool_system_disk_category == "cloud_auto"
    error_message = "ack_disk_category must reach the node pool; it was a hardcoded literal before this change."
  }

  assert {
    condition     = module.cluster[0].node_pool_system_disk_provisioned_iops == 6000
    error_message = "ack_disk_provisioned_iops must reach the node pool on cloud_auto."
  }

  assert {
    condition     = module.cluster[0].node_pool_system_disk_performance_level == null
    error_message = "A cloud_auto pool must send no ESSD performance level — that argument belongs to cloud_essd."
  }
}

run "a_price_limited_spot_pool_carries_its_ceilings" {
  command = plan

  variables {
    ack_node_capacity_type = "SpotWithPriceLimit"
    ack_spot_price_limit = [
      { instance_type = "ecs.g6.large", price_limit = "0.35" },
      { instance_type = "ecs.g6.xlarge", price_limit = "0.70" },
    ]
  }

  assert {
    condition     = module.cluster[0].node_pool_spot_strategy == "SpotWithPriceLimit"
    error_message = "ack_node_capacity_type must reach the node pool's spot_strategy."
  }

  assert {
    condition     = module.cluster[0].node_pool_spot_price_limit_count == 2
    error_message = "Both bid ceilings must be rendered as spot_price_limit blocks ON THE NODE POOL."
  }

  assert {
    condition = contains(
      local.ack_spot_price_limits,
      { instance_type = "ecs.g6.large", price_limit = "0.35" }
    )
    error_message = "A bid ceiling must reach the node pool with BOTH its instance type and its price — a block rendered with either half dropped bids at the wrong price."
  }
}

# SpotAsPriceGo bids the market rate and takes no ceilings, so it must be accepted with an empty
# list. Without this run, gate CLUSTER-003 would be satisfiable by demanding ceilings for every
# spot strategy, which would make the cheaper of the two unreachable.
run "market_rate_spot_needs_no_ceilings" {
  command = plan

  variables {
    ack_node_capacity_type = "SpotAsPriceGo"
  }

  assert {
    condition     = module.cluster[0].node_pool_spot_strategy == "SpotAsPriceGo" && module.cluster[0].node_pool_spot_price_limit_count == 0
    error_message = "SpotAsPriceGo must reach the node pool and render no spot_price_limit block — it bids the market rate and takes no ceilings. Reaching this run at all is the other half of the claim: the four gates must let this strategy plan."
  }
}

################################################################################
# 3. The gates
################################################################################

# CLUSTER-001. The value would be accepted by tofu and dropped by Alibaba, so a warning is not
# enough — both the `check` and the apply gate must fire.
run "a_performance_level_on_a_non_essd_disk_blocks_the_plan" {
  command = plan

  variables {
    ack_disk_category          = "cloud_auto"
    ack_disk_performance_level = 2
  }

  expect_failures = [
    check.ack_performance_level_needs_essd,
    terraform_data.ack_node_shape_guard,
  ]
}

# CLUSTER-002, and the mirror image: IOPS asked for on the DEFAULT category. This is the likeliest
# real mistake — someone reaches for aws's `eks_volume_iops` and sets the number without touching
# the category at all.
run "provisioned_iops_on_the_default_essd_disk_blocks_the_plan" {
  command = plan

  variables {
    ack_disk_provisioned_iops = 6000
  }

  expect_failures = [
    check.ack_provisioned_iops_needs_cloud_auto,
    terraform_data.ack_node_shape_guard,
  ]
}

# CLUSTER-003. A price-limited pool with no limit reads as a cost control and is not one.
run "price_limited_spot_without_a_limit_blocks_the_plan" {
  command = plan

  variables {
    ack_node_capacity_type = "SpotWithPriceLimit"
  }

  expect_failures = [
    check.ack_price_limited_spot_has_a_limit,
    terraform_data.ack_node_shape_guard,
  ]
}

# CLUSTER-004, the inverse — and the one that would ship silently without a gate: the ceilings are
# configured, the pool is on-demand, and the module renders no spot_price_limit block at all.
run "ceilings_without_a_bidding_strategy_block_the_plan" {
  command = plan

  variables {
    ack_spot_price_limit = [
      { instance_type = "ecs.g6.large", price_limit = "0.35" },
    ]
  }

  expect_failures = [
    check.ack_price_limits_need_a_spot_strategy,
    terraform_data.ack_node_shape_guard,
  ]
}

# ACK's create API resolves a ROS component by EXACT version string. The template declares a MINOR
# (matching compat/matrix.json and the other four clouds) and ack-version.tf resolves it against the
# versions the region actually offers. This is the direction that keeps the resolver honest: the
# mock above makes every ordinary run find a match, so without a run that finds NONE the guard would
# be satisfied by its own fixture and would never be shown to fire.
#
# 1.29 is inside no offered patch line, and is also outside the compat window — so BOTH gates trip,
# which is the correct behaviour and is asserted as such rather than papered over with one.
run "a_minor_with_no_offered_patch_blocks_the_plan" {
  command = plan

  variables {
    ack_cluster_version = "1.29"
  }

  expect_failures = [
    check.compat_k8s_supported,
    terraform_data.compat_k8s_guard,
    terraform_data.ack_version_resolvable,
  ]
}

# The same guard, INSIDE the compat window — the case that isolates the resolver from the compat
# gate. 1.33 is supported by matrix.json, so compat passes; the mock offers no 1.33.x, so only
# ack_version_resolvable trips. If this run ever starts passing, the resolver has stopped resolving
# and every alibaba apply is one Alibaba patch-retirement away from `no ros component exists`.
run "a_supported_minor_the_region_does_not_offer_blocks_the_plan" {
  command = plan

  variables {
    ack_cluster_version = "1.33"
  }

  expect_failures = [
    terraform_data.ack_version_resolvable,
  ]
}
