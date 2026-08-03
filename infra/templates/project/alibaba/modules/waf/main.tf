# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.6"
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230"
    }
  }
}

# Web Application Firewall (WAF 3.0). The parent template gates this module behind
# `application_waf_enabled`.
#
# THE RESOURCE TAKES NO ARGUMENTS. That is not an omission here — it is the whole schema.
# Verified against the pinned provider (aliyun/alicloud 1.286.0, .terraform.lock.hcl):
# `alicloud_wafv3_instance` declares exactly four attributes and every one of them is computed
# (`id`, `instance_id`, `create_time`, `status`) plus a `timeouts` block. There is no spec, no
# charge type, no domain, no tag — nothing to configure and nothing to attach. That is why this
# module now takes no variables: the two it used to declare (`domain`, `tags`) could never be
# referenced, and a declared-but-unreachable input reads like a wired feature.
#
# What the resource DOES do is buy. The provider's Create calls the `CreatePostpaidInstance`
# API and its Delete calls `ReleaseInstance`. WAF 3.0's postpaid instance is ACCOUNT-scoped per
# region — the companion data source `alicloud_wafv3_instances` accepts no filter arguments at
# all, it simply returns the account's ids. So two Alethia projects in one Alibaba account do
# not get two firewalls: the second adopts the first's instance into its own state, and
# destroying EITHER project releases the account's WAF out from under the other. That is a
# cross-project blast radius this module cannot fix from inside a per-project state — it needs the
# WAF modelled as an account-level construct. Recorded here rather than papered over, tracked as
# #1841.
#
# WHY NOTHING IS PROTECTED YET. Binding a hostname to this instance means
# `alicloud_wafv3_domain`, and in the pinned provider that resource speaks ONE access mode:
# `access_type = "share"`, WAF 3.0's CNAME record mode — the only value its documentation lists.
# It requires a `redirect` block naming `backends`, "the IP addresses or domain names of the
# origin server", and it filters traffic only once the domain's DNS points at the CNAME WAF
# hands back. The origin here is the ingress load balancer that ACK's in-cluster controller
# creates AFTER the cluster is up, so it does not exist at plan time and no HCL conjures it.
#
# The mode that WOULD be the analogue of the AWS ALB's `wafv2-acl-arn` annotation is WAF 3.0's
# cloud-native access (a transparent proxy for CLB/NLB/ECS, an in-line SDK for ALB), which binds
# a load balancer with no DNS change at all. The pinned provider exposes NO resource for it: the
# entire wafv3 surface is instance, domain, address_book, defense_rule, defense_template and
# defense_resource_group. Alibaba's own documentation also warns that the two modes must not
# both be configured for one origin — they conflict and protection fails.
#
# So the instance id is EXPORTED (modules/waf/outputs.tf → the root's `waf_instance_id`) and the
# attach is left undone and SAID so: packages/core/argocd/decisions.go reports this cloud's WAF
# as built, billed and inspecting nothing, instead of letting a project quietly pay for a
# firewall with no traffic behind it. A fabricated `alicloud_wafv3_domain` pointed at a guessed
# origin would be worse than the gap — it would register the hostname with WAF, return a CNAME,
# and forward to nowhere. The binding itself is tracked as #1840; it is not a tofu change.
resource "alicloud_wafv3_instance" "this" {}
