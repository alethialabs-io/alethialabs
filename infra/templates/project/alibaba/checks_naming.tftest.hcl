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
