# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source = "aliyun/alicloud"
      # >= 1.283 for `alicloud_cr_ee_repo.tag_immutability`. The root lockfile already resolves
      # 1.286.0; the floor exists so a fresh init that picked a 1.23x–1.28x provider fails with a
      # version error instead of "Unsupported argument" — or, worse, silently building mutable
      # repositories on a provider that predates the argument.
      version = ">= 1.283"
    }
  }
}

# Container Registry Enterprise Edition instance.
#
# `payment_type = "Subscription"` is not a choice — ACR Enterprise Edition has NO pay-as-you-go
# model. Verified against the billing API rather than assumed: `DescribePricingModule` for
# `ProductCode=acr` returns five pricing modules under `SubscriptionType=Subscription` and ZERO
# under `PayAsYouGo`. So this resource is the only prepaid thing in the repository because the
# product gives no alternative, not because nobody looked.
#
# It is also not cheap, and the number belongs next to the resource rather than in a board:
# Basic in eu-central-1 is **150 USD/month** (1800/year, no term discount; Advanced is 617/month;
# there is no tier below Basic). `instance_name` is `cr-<project>-<environment>`, so a full bar
# buys ONE OF THESE PER RUN.
#
# `renewal_status = "ManualRenewal"` is the blast-radius cap, and it is load-bearing precisely
# because the teardown story is unsettled. #2333 (docs/research/alibaba-cr-ee-subscription-release.md)
# records that the provider's Delete calls `RefundInstance` with `ImmediatelyRelease = "1"` while
# Alibaba's own ACR documentation states Terraform cannot release a subscription instance — and
# nothing has settled which wins. Under the pessimistic reading a leaked instance is a RECURRING
# 150 USD/month; pinned to manual renewal it is 150 USD ONCE. The argument was previously unset
# anywhere in infra/, so the account-level renewal default applied — which is not a decision
# anyone made.
#
# `ManualRenewal`, NOT `NotRenewal`: the provider validates this argument against exactly
# [AutoRenewal ManualRenewal] and rejects anything else. `NotRenewal` is the value Alibaba's own
# SetRenewal API takes and it is NOT accepted here — `tofu validate` refuses it outright, which is
# how this was caught rather than shipped. Manual renewal means renewal requires a deliberate human
# action, so the practical effect is the same: nothing renews on its own.
resource "alicloud_cr_ee_instance" "this" {
  payment_type   = "Subscription"
  period         = 1
  instance_type  = "Basic"
  instance_name  = var.instance_name
  renewal_status = "ManualRenewal"
}

# Namespace inside the CR EE instance.
resource "alicloud_cr_ee_namespace" "this" {
  instance_id        = alicloud_cr_ee_instance.this.id
  name               = var.namespace_name
  auto_create        = false
  default_visibility = "PRIVATE"
}

# The repositories themselves. This resource was MISSING (#1837): the module created the paid
# Enterprise Edition instance above and a namespace, and stopped — and a namespace is not something
# you can push an image to. `auto_create = false` on the namespace makes that unambiguous: nothing
# would have appeared on first push either.
#
# `tag_immutability` is the canvas's "Immutable tags" switch. It is an argument on the REPOSITORY,
# which is why the switch could not be carried until this resource existed. It is deliberately not
# anywhere near `alicloud_cr_ee_instance` above: that instance is `payment_type = "Subscription"`,
# so a switch landing on one of its arguments would put a monthly commitment behind a checkbox and
# could force the whole registry to be replaced. Changing tag immutability here is an in-place
# update of one repository and touches neither the instance nor the namespace.
resource "alicloud_cr_ee_repo" "this" {
  for_each = var.repos

  instance_id = alicloud_cr_ee_instance.this.id
  namespace   = alicloud_cr_ee_namespace.this.name
  name        = each.key
  summary     = each.value.summary
  # Matches the namespace's own default_visibility — a private project's images are not published
  # by the act of creating a repository for them.
  repo_type        = "PRIVATE"
  tag_immutability = each.value.immutable_tags
}

# Image scanning (#1845). The canvas's "Vulnerability scanning" switch. Like `tag_immutability`
# above it never touches `alicloud_cr_ee_instance` — but here that discipline needs naming twice,
# because the instance HAS two adjacent-looking arguments and both are traps (#1933):
# `image_scanner` and `vpc_quota` are not ForceNew yet are absent from the provider's Update
# function, so changing either plans a diff, applies "successfully" and does nothing — and the
# only real change path is replacing the Subscription-billed registry (Delete = RefundInstance
# with immediate release — which the provider genuinely calls, though Alibaba's own ACR docs say it
# does not release a subscription; that contradiction is unsettled and tracked in #2333, see
# docs/research/alibaba-cr-ee-subscription-release.md. Either way, replacing this registry is not
# something a checkbox should be able to trigger). Scanning is expressed instead as a SIBLING resource: one REPO-scoped
# rule per repository whose switch is on; OFF is the ABSENCE of the rule.
#
# Plan-green is NOT proof a scan runs. Alibaba couples batch scanning to an instance VPC and
# leaves the AUTO trigger's prerequisite undocumented in both languages
# (docs/research/alibaba-cr-scan-rule-vpc.md) — the runtime proof, push an image and observe a
# scan result, is owed by the alibaba e2e nightly (#2061/#2101).
resource "alicloud_cr_scan_rule" "this" {
  # `alicloud_cr_scan_rule` is in the provider since 1.265.0, inside the module's >= 1.283 floor.
  for_each = { for name, repo in var.repos : name => repo if repo.vulnerability_scanning }

  instance_id = alicloud_cr_ee_instance.this.id
  rule_name   = "${each.key}-vul"
  scan_scope  = "REPO"
  namespaces  = [alicloud_cr_ee_namespace.this.name]
  repo_names  = [each.key]
  # Required by the provider even for REPO scope; `.*` — every tag — is the console's own default.
  repo_tag_filter_pattern = ".*"
  trigger_type            = "AUTO"
  # ForceNew — pinned to VUL (vulnerability). Never thread a canvas switch through this argument:
  # flipping it would replace the rule, and SBOM is a different product than the switch promises.
  scan_type = "VUL"
}
