# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the WAF switch has a VISIBLE outcome — and only the outcome it really has.
#
# The WAF module used to be a resource with no arguments, two module variables no resource could
# read, and no root output. Turning the canvas switch on therefore bought an account-scoped WAF 3.0
# postpaid instance and produced a plan that looked, from outside, identical to leaving it off. This
# file pins the two halves of the fix:
#
#   1. `waf_instance_id` is exported when the switch is on and is null when it is off, so
#      argocd.InfraFacts can tell "off" from "on and filtering nothing" (packages/core/argocd —
#      TestBuildFromOutputs_AlibabaWAFInstanceID reads it back from the other side).
#   2. The WAF is INDEPENDENT of the cluster. It is bought whether or not `provision_ack` is set,
#      which is worth pinning precisely because it is a cost with no cluster to justify it.
#
# What is deliberately NOT here is an `alicloud_wafv3_domain`. The pinned provider binds a hostname
# only in CNAME mode, and that needs the ingress load balancer's address, which does not exist at
# plan time — modules/waf/main.tf carries the schema evidence. A test cannot assert the absence of a
# resource the configuration never declares, so the guard against a fabricated binding lives in
# packages/core/argocd/decisions.go (wafAttachesToIngress) and its tests instead: the WAF must keep
# reporting "skipped" on alibaba even once an ingress lane gives this cloud a managed ArgoCD URL.
#
# Providers are mocked, so this needs no credentials and runs on any PR.

mock_provider "alicloud" {
  # Same zone/vswitch mocking rationale as checks_secrets.tftest.hcl: the zone IDS come from this
  # data source and modules/network calls element() on them, which is a hard error on an empty list.
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

  # `instance_id` is COMPUTED on alicloud_wafv3_instance — every attribute on that resource is —
  # so it is pinned to a realistic value here rather than left to the mock's generated string. The
  # assertions below are about the id REACHING the root output, and a literal makes that legible.
  mock_resource "alicloud_wafv3_instance" {
    defaults = {
      instance_id = "waf_v3prepaid_public_cn-0xldbqt0007"
    }
  }
}

mock_provider "random" {}

variables {
  project_name = "alethia-nl"
  region       = "eu-central-1"
  environment  = "production"

  # No cluster: the WAF's independence from ACK is half of what this suite pins, and it keeps the
  # runs cheap. The one run that needs a cluster turns it back on.
  provision_ack = false
}

################################################################################
# 1. The switch OFF builds nothing and exports nothing
################################################################################

run "waf_off_creates_no_instance_and_exports_null" {
  command = plan

  variables {
    application_waf_enabled = false
  }

  assert {
    condition     = length(module.waf) == 0
    error_message = "application_waf_enabled = false must produce no WAF module instance — the postpaid instance is a real charge."
  }

  # null, not "". ExtractOutput maps a null to "" on the Go side, which is the "nothing built"
  # signal wafDecision keys on; a present-but-empty id would be reported as an unattached WAF and
  # tell every Alibaba project it is paying for a firewall it never asked for.
  assert {
    condition     = output.waf_instance_id == null
    error_message = "With the WAF switch off, waf_instance_id must be null."
  }
}

################################################################################
# 2. The switch ON buys the instance AND says so
################################################################################

run "waf_on_creates_the_instance_and_exports_its_id" {
  command = plan

  variables {
    application_waf_enabled = true
  }

  assert {
    condition     = length(module.waf) == 1
    error_message = "application_waf_enabled = true must create the WAF module instance."
  }

  # THE POINT OF THE OUTPUT. Before it existed, this plan and the one above were indistinguishable
  # from outside the state, so a WAF that filters nothing was invisible to the console and the CLI.
  assert {
    condition     = output.waf_instance_id == "waf_v3prepaid_public_cn-0xldbqt0007"
    error_message = "The WAF instance id must reach the root output — argocd.InfraFacts.AlibabaWAFInstanceID reads this key."
  }
}

################################################################################
# 3. The WAF does not depend on the cluster — in either direction
################################################################################

# A cluster-less project with the WAF on is a real shape (the switch lives on the DNS component,
# not the cluster one) and it must plan. It is also the starkest version of the cost: an account
# firewall bought for a project that runs nothing.
run "waf_on_without_a_cluster_still_plans_and_exports" {
  command = plan

  variables {
    application_waf_enabled = true
    provision_ack           = false
  }

  assert {
    condition     = length(module.waf) == 1 && output.waf_instance_id != null
    error_message = "The WAF is independent of ACK; a cluster-less project must still plan and export the instance id."
  }

  assert {
    condition     = length(module.cluster) == 0
    error_message = "provision_ack = false must produce no ACK module instance."
  }
}

# The other direction: a cluster must not switch the WAF on by itself. This is what stops the WAF
# quietly becoming a per-cluster default charge if the gate is ever widened.
run "a_cluster_does_not_imply_a_waf" {
  command = plan

  variables {
    provision_ack           = true
    application_waf_enabled = false
  }

  assert {
    condition     = length(module.cluster) == 1 && length(module.waf) == 0
    error_message = "Provisioning a cluster must not buy a WAF instance — the switch is the only thing that may."
  }
}
