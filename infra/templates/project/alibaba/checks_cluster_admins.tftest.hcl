# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof for the ACK cluster-admin grants (#2005) and the ADMINS-001 gate in
# checks_cluster_admins.tf.
#
# The parity page used to record cluster admins as "granted outside the template" on Alibaba —
# refuted against the pinned provider, whose alicloud_cs_kubernetes_permissions is exactly a
# cluster-admin binding. These runs pin the replacement claim: the knob plans a grant per
# principal, shaped role_type "cluster" / role_name "admin", and the shapes that would silently
# grant nothing (no cluster; duplicate uids racing a replace-not-merge API) refuse to plan.
#
# Assertions read the PLANNED alicloud_cs_kubernetes_permissions resource, not the variable that
# feeds it — "declared, derived, and read by nothing" is the unwired-template defect this suite
# exists to end (see checks_cluster.tftest.hcl).
#
# The alicloud mock is copied from checks_cluster.tftest.hcl; its entries are load-bearing and the
# comments in checks_secrets.tftest.hcl record why (empty computed lists break element(); the ACK
# resource validates vswitch id FORMAT before any API call; rrsa_metadata is a computed nested
# block the outputs read).

mock_provider "alicloud" {
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
# 1. The default grants nothing
################################################################################

# The run the "byte-identical by default" claim is answerable to: a project that never heard of
# this knob must plan zero permission resources.
run "a_project_that_sets_nothing_grants_no_admin" {
  command = plan

  assert {
    condition     = length(alicloud_cs_kubernetes_permissions.cluster_admin) == 0
    error_message = "With ack_cluster_admins unset, NO alicloud_cs_kubernetes_permissions resource may be planned — the default must leave the plan exactly as it was before the knob existed."
  }
}

################################################################################
# 2. A grant actually reaches the permission resource
################################################################################

run "each_admin_plans_a_cluster_scoped_admin_grant" {
  command = plan

  variables {
    ack_cluster_admins = [
      { uid = "301234567890123456" },                      # RAM role — the keyless default
      { uid = "201234567890123456", is_ram_role = false }, # RAM user, opted out explicitly
    ]
  }

  assert {
    condition     = length(alicloud_cs_kubernetes_permissions.cluster_admin) == 2
    error_message = "Every listed principal must plan its own alicloud_cs_kubernetes_permissions resource — one resource per uid is what keeps the replace-not-merge grant composed in a single place."
  }

  assert {
    condition     = alicloud_cs_kubernetes_permissions.cluster_admin["301234567890123456"].uid == "301234567890123456"
    error_message = "The grant must be keyed and planned by the principal's uid."
  }

  assert {
    condition     = one(alicloud_cs_kubernetes_permissions.cluster_admin["301234567890123456"].permissions[*].role_type) == "cluster"
    error_message = "The grant must be CLUSTER-scoped (role_type = \"cluster\") — a namespace-scoped grant is not cluster admin. Read off the planned resource, not the variable, so deleting the assignment fails here."
  }

  assert {
    condition     = one(alicloud_cs_kubernetes_permissions.cluster_admin["301234567890123456"].permissions[*].role_name) == "admin"
    error_message = "The grant must carry role_name = \"admin\" on the planned resource."
  }

  assert {
    condition     = one(alicloud_cs_kubernetes_permissions.cluster_admin["301234567890123456"].permissions[*].is_ram_role) == true
    error_message = "An entry that says nothing about is_ram_role must plan a RAM-ROLE grant — the keyless RRSA/AssumeRole model is the default, not the exception."
  }

  assert {
    condition     = one(alicloud_cs_kubernetes_permissions.cluster_admin["201234567890123456"].permissions[*].is_ram_role) == false
    error_message = "is_ram_role = false must reach the planned resource — a RAM-user grant bound as a role grants nobody anything."
  }
}

################################################################################
# 3. The gates
################################################################################

# ADMINS-001. With no cluster the for_each filters every grant away — the plan would be clean, the
# apply clean, and every listed principal silently granted nothing.
run "admins_without_a_cluster_block_the_plan" {
  command = plan

  variables {
    provision_ack = false
    ack_cluster_admins = [
      { uid = "301234567890123456" },
    ]
  }

  expect_failures = [
    check.ack_cluster_admins_need_a_cluster,
    terraform_data.ack_cluster_admins_guard,
  ]
}

# Duplicate uids: ACK's grant is a replace, so two entries for one principal would race over the
# same permission set — and the for_each map would silently keep the last writer. Refused at the
# variable instead.
run "duplicate_admin_uids_block_the_plan" {
  command = plan

  variables {
    ack_cluster_admins = [
      { uid = "301234567890123456" },
      { uid = "301234567890123456", is_ram_role = false },
    ]
  }

  expect_failures = [
    var.ack_cluster_admins,
  ]
}
