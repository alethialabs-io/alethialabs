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
resource "alicloud_cr_ee_instance" "this" {
  payment_type  = "Subscription"
  period        = 1
  instance_type = "Basic"
  instance_name = var.instance_name
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
