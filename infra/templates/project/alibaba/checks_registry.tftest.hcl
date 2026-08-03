# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that a Container Registry repository is created at all, and that the canvas's "Immutable
# tags" switch reaches `alicloud_cr_ee_repo.tag_immutability` in BOTH positions.
#
# Until #1837 `modules/cr` created an `alicloud_cr_ee_instance` — `payment_type = "Subscription"`, a
# real monthly commitment — plus a namespace, and stopped. A namespace is not somewhere you can push
# an image, and `auto_create = false` means nothing appeared on first push either. So a native
# Alibaba registry bought a subscription and delivered nothing, and the switch could not be carried
# because `tag_immutability` is an argument on the repository and there was no repository.
#
# The OFF run is the one that earns this file. The offer-parity guard asks only whether some resource
# argument reads the name; a module that hardcoded `tag_immutability = true` would satisfy it, and
# would satisfy any test that asserted only the enabled case.
#
# At the ROOT on purpose: `modules/**/*.tftest.hcl` is silently never executed.
#
# Providers are mocked and the cluster is off, so this needs no credentials and runs on any PR.

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
}

mock_provider "random" {}

variables {
  project_name = "alethia-nl"
  region       = "eu-central-1"
  environment  = "production"

  # The registry is the subject; the cluster is not needed to decide any of it.
  provision_ack = false
  provision_cr  = true
}

# ON. `tag_immutability` must plan true on the repository resource.
run "immutable_tags_on_reaches_the_repository" {
  command = plan

  variables {
    cr_repos = {
      apps = { summary = "Container images for apps", immutable_tags = true }
    }
  }

  # The repository has to EXIST before its arguments can mean anything — this is #1837 itself, and
  # it is asserted rather than assumed because for the whole life of this module the answer was no.
  assert {
    condition     = length(module.cr[0].repository_paths) == 1
    error_message = "provision_cr with one repository must create one alicloud_cr_ee_repo; got ${jsonencode(module.cr[0].repository_paths)}."
  }

  assert {
    condition     = module.cr[0].repository_immutable_tags["apps"] == true
    error_message = "immutable_tags = true was not planned onto alicloud_cr_ee_repo.tag_immutability; got ${jsonencode(module.cr[0].repository_immutable_tags)}."
  }
}

# OFF — the half that distinguishes a wired switch from a hardcoded one.
run "immutable_tags_off_reaches_the_repository" {
  command = plan

  variables {
    cr_repos = {
      apps = { summary = "Container images for apps", immutable_tags = false }
    }
  }

  assert {
    condition     = module.cr[0].repository_immutable_tags["apps"] == false
    error_message = "immutable_tags = false was ignored — the switch's OFF position must plan differently from its ON position. Got ${jsonencode(module.cr[0].repository_immutable_tags)}."
  }
}

# An omitted switch takes the SAFE setting. A snapshot written before #1811 carries no value, and
# defaulting it off would turn tag immutability off on a repository nobody asked to change.
run "an_omitted_switch_defaults_to_immutable" {
  command = plan

  variables {
    cr_repos = {
      apps = {}
    }
  }

  assert {
    condition     = module.cr[0].repository_immutable_tags["apps"] == true
    error_message = "A repository configured with no immutable_tags value must default to immutable. Got ${jsonencode(module.cr[0].repository_immutable_tags)}."
  }
}

# The shape that used to be the ONLY shape: provisioning switched on with nothing to create. Here it
# is not merely useless — it buys a paid CR Enterprise Edition subscription for an empty namespace.
run "provisioning_with_no_repositories_is_refused" {
  command = plan

  variables {
    cr_repos = {}
  }

  expect_failures = [check.cr_repos_present_when_provisioned]
}

# The map key becomes the repository name, and Alibaba constrains it. The emitter does not normalise
# it (it is also the lookup key of the paths output), so a bad name has to be refused at plan rather
# than discovered mid-apply against a subscription that has already been bought.
run "an_illegal_repository_name_is_refused" {
  command = plan

  variables {
    cr_repos = {
      "Apps Prod" = {}
    }
  }

  expect_failures = [check.cr_repo_names_valid]
}
