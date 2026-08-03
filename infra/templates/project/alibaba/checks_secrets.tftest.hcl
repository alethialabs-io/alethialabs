# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that `provision_ack = false` plans, and that the RRSA / external-secrets invariants hold.
#
# The AWS twin of the first property was broken for the whole life of that template: thirteen call
# sites indexed `module.eks[0]` outside any count, so `provision_eks = false` died at plan with
# "Invalid index … module.eks is empty tuple" before a single resource existed (#1772). Alibaba
# survives the same shape, but for a reason thinner than it looks — checks_secrets.tf's
# `!var.provision_ack || … module.cluster[0] …` was protected only by `||` SHORT-CIRCUITING, with
# none of the `try()` that aws and gcp carry. That has been corrected; this file is what keeps it
# corrected, because `tofu validate` sees none of it: it never expands a count and never evaluates a
# check block.
#
# This is also the first .tftest.hcl in this directory, which is what switches `tofu test` on for
# alibaba at all: .github/workflows/infra-templates.yml skips the step with a notice for any cloud
# that has no suite, so until now alibaba's guards were never executed by CI.
#
# Providers are mocked, so this needs no credentials and runs on any PR.

mock_provider "alicloud" {
  # PLAN-OUT SAFETY (#621) keeps the zone COUNT static, but the zone IDS still come from this data
  # source, and modules/network calls element(local.zones, count.index) on them. The mock's default
  # for a computed LIST is an empty list, and element() on an empty list is a hard error — so the
  # zones have to be populated for any plan to complete. Two are enough for the vswitch wrap.
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

  # The ACK resource validates the FORMAT of the vswitch ids it is handed ("should start with
  # 'vsw-'") before any API call, and the mock's generated string does not. Needed only by the
  # cluster-ful runs below.
  mock_resource "alicloud_vswitch" {
    defaults = {
      id = "vsw-0123456789abcdefghijklmn"
    }
  }

  # The mock leaves computed NESTED BLOCKS as empty lists, and modules/cluster/outputs.tf reads
  # rrsa_metadata[0] for both RRSA values — so without this the cluster reports NO OIDC provider and
  # checks_secrets.tf's ack_rrsa_provider_present fires. That check is the subject of the suite, not
  # collateral: it must fail for a real missing provider, never for a mocking gap.
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

  # THE shape under test. Runs that need a cluster turn it back on explicitly.
  provision_ack = false
}

################################################################################
# 1. The cluster-less shape plans and creates nothing cluster-scoped
################################################################################

run "a_clusterless_project_plans" {
  command = plan

  assert {
    condition     = length(module.cluster) == 0
    error_message = "provision_ack = false must produce no ACK module instance."
  }

  # The cluster outputs are empty strings rather than null here — an alibaba-local convention this
  # template already follows. Pinned so "make it plan" cannot quietly change the CONTRACT: the runner
  # harvests root outputs into jobs.execution_metadata and downstream readers test for "".
  assert {
    condition = alltrue([
      output.ack_cluster_name == "",
      output.ack_cluster_endpoint == "",
      output.rrsa_oidc_issuer_url == "",
      output.rrsa_oidc_provider_arn == "",
      output.external_secrets_ram_role_arn == "",
    ])
    error_message = "Cluster outputs must resolve to \"\" on a cluster-less shape, not an Invalid index error."
  }
}

# The RRSA role's trust policy names module.cluster[0].rrsa_oidc_provider_arn TWICE, so it is the
# alibaba analogue of the AWS IRSA roles that made `provision_eks = false` unplannable. Its guard
# (`eso_rrsa_enabled`) already carries `var.provision_ack`, unlike the AWS locals that did not — this
# run is what stops that term being dropped as apparently redundant.
run "native_kms_secrets_without_a_cluster_plan" {
  command = plan

  variables {
    secrets_provider = "native"
    custom_secrets = [{
      name = "app-secret"
    }]
  }

  assert {
    condition     = local.eso_rrsa_enabled == false
    error_message = "Without a cluster there is no RRSA OIDC provider to trust; the external-secrets role must be inert."
  }

  assert {
    condition = alltrue([
      length(alicloud_ram_role.external_secrets) == 0,
      length(alicloud_ram_policy.external_secrets_read) == 0,
      length(alicloud_ram_role_policy_attachment.external_secrets_read) == 0,
    ])
    error_message = "The RRSA role, its policy and the attachment must drop out together — a policy outliving its role is an orphan."
  }

  # The secrets themselves are NOT cluster-scoped and must still be created. Without this half the
  # run would also pass if a cluster-less shape silently dropped the whole secrets lane, which would
  # break a real, useful project shape in order to fix a crash.
  assert {
    condition     = length(module.kms) == 1 && length(module.kms[0].secret_names) == 1
    error_message = "KMS secrets are independent of the cluster and must still be created."
  }
}

################################################################################
# 2. The other side — with a cluster, the RRSA role must actually be there
################################################################################

# Everything above would also pass if `module "cluster"` and the RRSA role were simply deleted. This
# run is what makes the suite an invariant rather than a licence to remove them.
run "a_cluster_with_native_secrets_creates_the_rrsa_role" {
  command = plan

  variables {
    provision_ack    = true
    secrets_provider = "native"
    custom_secrets = [{
      name = "app-secret"
    }]
  }

  assert {
    condition     = length(module.cluster) == 1 && local.eso_rrsa_enabled == true
    error_message = "provision_ack = true with native KMS secrets must create the cluster and enable the RRSA role."
  }

  assert {
    condition = alltrue([
      length(alicloud_ram_role.external_secrets) == 1,
      length(alicloud_ram_policy.external_secrets_read) == 1,
      length(alicloud_ram_role_policy_attachment.external_secrets_read) == 1,
    ])
    error_message = "The external-secrets RRSA role, its read policy and the attachment must all be created."
  }

  # Least-privilege is the point of the policy, so the scoping is asserted rather than assumed: an
  # account-wide "secret/*" would satisfy every other assertion here and hand the operator every
  # secret in the account.
  assert {
    condition     = can(regex("secret/alethia-nl-production-", alicloud_ram_policy.external_secrets_read[0].policy_document)) && !can(regex("secret/\\*", alicloud_ram_policy.external_secrets_read[0].policy_document))
    error_message = "The external-secrets read policy must be scoped to THIS project's secret prefix, never account-wide."
  }
}

# A cluster with NO native secrets must not create the role either — `eso_rrsa_enabled` has three
# terms and this pins the one that is neither the cluster nor the provider choice.
run "a_cluster_without_secrets_creates_no_rrsa_role" {
  command = plan

  variables {
    provision_ack    = true
    secrets_provider = "native"
    custom_secrets   = []
  }

  assert {
    condition     = local.eso_rrsa_enabled == false && length(alicloud_ram_role.external_secrets) == 0
    error_message = "With no secrets to read there is nothing for the external-secrets role to be granted."
  }
}

# A pluggable secrets connector means the cluster reads someone else's store, so the native RRSA
# role must stay dark even with a cluster AND secrets present.
run "a_pluggable_secrets_provider_creates_no_native_rrsa_role" {
  command = plan

  variables {
    provision_ack    = true
    secrets_provider = "vault"
    custom_secrets = [{
      name = "app-secret"
    }]
  }

  assert {
    condition     = local.eso_rrsa_enabled == false && length(alicloud_ram_role.external_secrets) == 0
    error_message = "A non-native secrets provider must not create the native KMS RRSA role."
  }
}
