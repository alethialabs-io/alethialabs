# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that NAMING-003 produces a Tablestore instance name Alibaba will accept.
#
# The alicloud mock below is not boilerplate: it is copied deliberately from
# checks_secrets.tftest.hcl, which discovered that the mock's default for a computed LIST is an
# EMPTY list, and modules/network calls element(local.zones, count.index) on it — element() on an
# empty list is a hard error, so no plan completes at all without populated zones. A naming suite
# needs no network, but it cannot reach a local without a successful plan.
#
# The digests below are literal on purpose. Recomputing sha256 inside the assertion would pass
# against a broken derivation, because both sides would drift together.
#
# Providers are mocked, so this needs no credentials and runs on any PR.

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
  region       = "eu-central-1"
  environment  = "production"
  project_name = "alethia-nl"

  # NAMING-003 is decided from plain variables before any resource exists, which is the property
  # that makes it testable. No cluster or store is needed to reach it.
  create_ots = false
}

################################################################################
# 1. A name that FITS is never touched
################################################################################

# Backward compatibility. A Tablestore instance that exists today has a name inside the cap, and a
# rename DESTROYS the store — so a fitting name must come through byte-identical.
run "a_short_name_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "a"
    environment  = "prod"
  }

  assert {
    condition     = local.ots_name == "otsaprod"
    error_message = "A short instance name must be kept verbatim, got ${local.ots_name}."
  }
}

# The exact boundary: 16 is legal, so it must NOT fall back.
run "a_name_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia"
    environment  = "prod12"
  }

  assert {
    condition     = local.ots_name == "otsalethiaprod12" && local.ots_name_len == 16
    error_message = "A name of exactly 16 characters must keep the readable form, got ${local.ots_name} (${local.ots_name_len} chars)."
  }
}

# One character over is the first case that must fall back — the off-by-one that would otherwise
# rename every instance sitting exactly on the cap.
run "a_name_one_over_the_cap_falls_back" {
  command = plan

  variables {
    project_name = "alethia"
    environment  = "prod123"
  }

  assert {
    condition     = local.ots_name != "otsalethiaprod123" && local.ots_name_len <= 16
    error_message = "A 17-character name must fall back, got ${local.ots_name} (${local.ots_name_len} chars)."
  }
}

################################################################################
# 2. The overflow — the case that fires on the Sunday full bar
################################################################################

# THE case from #1884. create_ots is full-bar-only, so this name is what the weekly run would try to
# create, and 24 > 16 means it never could.
run "the_e2e_nightly_environment_fits" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-1"
  }

  assert {
    condition     = local.ots_name == "ts03e65fa5bf37"
    error_message = "The e2e full-bar environment must render a 14-char instance name, got ${local.ots_name}."
  }

  assert {
    condition     = local.ots_name_len <= 16
    error_message = "NAMING-003 produced ${local.ots_name_len} chars — Alibaba caps Tablestore instance names at 16."
  }
}

# Alibaba requires the name to start with a LETTER and not end with a hyphen. The digest fallback
# must satisfy both by construction, for any input.
run "the_fallback_starts_with_a_letter_and_ends_alphanumeric" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-1"
  }

  assert {
    condition     = can(regex("^[a-z][a-z0-9]*[a-z0-9]$", local.ots_name))
    error_message = "The fallback must start with a letter and end alphanumeric, got ${local.ots_name}."
  }
}

# The reason the fallback is opaque rather than truncating user text in. A Tablestore name is
# reported not to be allowed to CONTAIN "ali", "ay", "ots", "taobao" or "admin". Hex is [0-9a-f] and
# carries none of the letters in any of them, so a "ts" + hex form is safe under that rule whether or
# not it turns out to be real — which truncated user text could never be shown to be.
run "the_fallback_carries_no_reserved_word" {
  command = plan

  variables {
    # "mayflower" carries "ay"; a truncating fallback could drag it into the name.
    project_name = "mayflower-alibaba"
    environment  = "30829641000-1"
  }

  assert {
    condition = alltrue([
      !strcontains(local.ots_name, "ali"),
      !strcontains(local.ots_name, "ay"),
      !strcontains(local.ots_name, "ots"),
      !strcontains(local.ots_name, "taobao"),
      !strcontains(local.ots_name, "admin"),
    ])
    error_message = "The fallback must carry no reserved word, got ${local.ots_name}."
  }
}

################################################################################
# 3. Distinct environments must not COLLIDE
################################################################################

# Two consecutive full-bar runs differ only in the trailing attempt digit. Under any truncating
# scheme they would resolve to ONE instance and silently share its tables.
run "two_environments_get_distinct_names_a" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-1"
  }

  assert {
    condition     = local.ots_name == "ts03e65fa5bf37"
    error_message = "Expected the -1 environment's own digest, got ${local.ots_name}."
  }
}

run "two_environments_get_distinct_names_b" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-2"
  }

  assert {
    condition     = local.ots_name == "tsfc8585ba35e4"
    error_message = "Expected the -2 environment's own digest (distinct from -1's 03e65fa5bf37), got ${local.ots_name}."
  }
}

################################################################################
# 4. The Container Registry instance (#1886)
#
# The second NAMING-003 name, and the one with the least margin: `cr-<project_name>-<environment>`
# renders 27 against a cap of 30 on the e2e full bar. It has never failed, and three characters is
# why — a GitHub run id gaining one digit takes it to 28.
#
# `instance_name` is ForceNew on alicloud_cr_ee_instance, so a rename DESTROYS AND RECREATES the
# registry and everything pushed to it. That is what makes "kept verbatim" the load-bearing case
# here rather than a formality.
################################################################################

run "cr_a_short_name_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia"
    environment  = "prod"
  }

  assert {
    condition     = local.cr_name == "cr-alethia-prod"
    error_message = "A 15-character registry name must be kept verbatim, got ${local.cr_name}."
  }
}

# The exact boundary. 30 is legal, so it must NOT fall back — an off-by-one here recreates every
# registry sitting exactly on the cap.
run "cr_a_name_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-we"
  }

  assert {
    condition     = local.cr_name == "cr-alethia-nl-production-eu-we" && local.cr_name_len == 30
    error_message = "A name of exactly 30 characters must keep the readable form, got ${local.cr_name} (${local.cr_name_len} chars)."
  }
}

run "cr_a_name_one_over_the_cap_falls_back" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-wes"
  }

  assert {
    condition     = local.cr_name == "cr-alethia-nl-producti-9e26f54"
    error_message = "A 31-character name must fall back to truncate-plus-digest, got ${local.cr_name}."
  }
}

# THE case from #1886 — the e2e full bar's own environment. It fits, and the point of pinning it is
# that it must KEEP fitting byte-for-byte: this is the name a live registry would carry.
run "cr_the_e2e_environment_is_kept_verbatim_with_three_chars_to_spare" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30829641000-1"
  }

  assert {
    condition     = local.cr_name == "cr-alethia-nl-30829641000-1" && local.cr_name_len == 27
    error_message = "The e2e environment must render the readable 27-char registry name, got ${local.cr_name} (${local.cr_name_len} chars)."
  }
}

# Alibaba rejects a name ending in a hyphen, and a truncation at 22 can land on one — or on a run of
# two, which `trimsuffix` would only half-remove. The derivation strips with a regex.
run "cr_a_truncation_landing_on_a_hyphen_trims_it" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "product-ion-eu-west-1"
  }

  assert {
    condition     = local.cr_name == "cr-alethia-nl-product-73418a6"
    error_message = "A truncation landing on a hyphen must trim it, got ${local.cr_name}."
  }
}

################################################################################
# 5. Truncation must not COLLIDE
#
# The reason the digest is over the FULL name and not the truncated stem. These two environments
# share their first 22 characters exactly; under plain truncation they would resolve to ONE registry
# and two environments would push images into the same namespace. Two runs of the nightly are
# precisely this shape.
################################################################################

run "cr_two_environments_sharing_a_prefix_get_distinct_names_a" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1"
  }

  assert {
    condition     = local.cr_name == "cr-alethia-nl-producti-98bd64a"
    error_message = "Expected the west-1 environment's own digest, got ${local.cr_name}."
  }
}

run "cr_two_environments_sharing_a_prefix_get_distinct_names_b" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-2"
  }

  assert {
    condition     = local.cr_name == "cr-alethia-nl-producti-863b150"
    error_message = "Expected the west-2 environment's own digest (distinct from west-1's 98bd64a), got ${local.cr_name}."
  }
}
