# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that a Tablestore table is planned with the primary key the caller asked for — #1836.
#
# The bug this pins was silent in every direction. `buildOTSTables` emitted a scalar `primary_key`
# while modules/ots/main.tf read `try(each.value.primary_keys, [{ name = "id", type = "String" }])`,
# a LIST under a different name. `try` swallowed the miss, `tables` was `list(any)` so nothing typed
# rejected the wrong shape, and the plan was clean: every Tablestore table in every Alibaba project
# was built on the fallback key `id`/`String` while the console showed the user's own choice. No
# error, no drift, no failing check — the wiring probe cannot see it either, because "does an
# argument read this name" is satisfied by the fallback.
#
# So the assertion here is about the VALUE, not the presence of a name. It reads
# `module.ots[0].table_primary_keys`, which is taken off the planned resource rather than off the
# input, and compares it to a key that is deliberately NOT `id`/`String` — under the old code every
# run below would come back `id`/`String` and fail.
#
# `modules/**/*.tftest.hcl` is silently never executed by `tofu test` (root-level only), which is
# why this sits here rather than next to the module it tests.
#
# Providers are mocked and no cluster is provisioned, so this needs no credentials and runs on any PR.

mock_provider "alicloud" {
  # PLAN-OUT SAFETY (#621) keeps the zone COUNT static, but modules/network still calls
  # element(local.zones, count.index) on the ids from this data source, and the mock's default for a
  # computed list is an empty list — element() on which is a hard error. Two zones are enough.
  # (Same block as checks_secrets.tftest.hcl, for the same reason.)
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
  # DELIBERATELY SHORT, and not because short names are typical. `local.ots_name` is
  # `replace("ots${project_name}${environment}", "-", "")` (locals.tf:22) while
  # `alicloud_ots_instance.name` is capped at 16 bytes, so the realistic
  # `alethia-nl` / `production` used by the other suites in this directory derives
  # `otsalethianlproduction` (22) and the plan is REFUSED by the provider before any assertion here
  # runs. That is a separate, pre-existing defect in a file this change does not own — reported for
  # filing, not fixed here — and it is why these two values are trimmed to keep the derived name
  # legal. The primary-key wiring under test is independent of the instance name.
  project_name = "nl"
  region       = "eu-central-1"
  environment  = "prod"

  # No cluster: Tablestore is independent of it, and a cluster-less plan is both faster and narrower.
  provision_ack = false

  create_ots = true
}

# ── The configured key reaches the table ─────────────────────────────────────────────
#
# `tenant_id` / `String` is chosen precisely because it is not the module's old fallback: a run that
# passed on `id`/`String` would be passing on the bug.
run "the_configured_primary_key_reaches_the_planned_table" {
  command = plan

  variables {
    ots_tables = [{
      name         = "sessions"
      primary_keys = [{ name = "tenant_id", type = "String" }]
    }]
  }

  assert {
    condition     = module.ots[0].table_primary_keys["sessions"] == [{ name = "tenant_id", type = "String" }]
    error_message = "The planned table must carry the configured primary key, not the module's old id/String fallback. Got ${jsonencode(module.ots[0].table_primary_keys["sessions"])}."
  }
}

# ── A non-String key type survives too ───────────────────────────────────────────────
#
# The TYPE travelled on the same broken path as the name (`primary_key_type`, read by nothing), so
# pinning only the name would leave half the defect in place. `Integer` is the value `otsKeyType`
# produces for the canvas's `N`, so this is the exact string the provider sends.
run "a_non_default_key_type_reaches_the_planned_table" {
  command = plan

  variables {
    ots_tables = [{
      name         = "events"
      primary_keys = [{ name = "event_seq", type = "Integer" }]
    }]
  }

  assert {
    condition     = module.ots[0].table_primary_keys["events"] == [{ name = "event_seq", type = "Integer" }]
    error_message = "The planned table must carry the configured key TYPE, not String. Got ${jsonencode(module.ots[0].table_primary_keys["events"])}."
  }
}

# ── Two tables do not collapse onto one key ──────────────────────────────────────────
#
# Both runs above would also pass for a template that applied the FIRST table's key to every table,
# which is a plausible shape for `for_each` over the wrong collection. This is what makes the pair an
# invariant rather than a single-row spot check.
run "each_table_keeps_its_own_primary_key" {
  command = plan

  variables {
    ots_tables = [
      {
        name         = "sessions"
        primary_keys = [{ name = "tenant_id", type = "String" }]
      },
      {
        name         = "events"
        primary_keys = [{ name = "event_seq", type = "Integer" }]
      },
    ]
  }

  assert {
    condition = alltrue([
      module.ots[0].table_primary_keys["sessions"] == [{ name = "tenant_id", type = "String" }],
      module.ots[0].table_primary_keys["events"] == [{ name = "event_seq", type = "Integer" }],
    ])
    error_message = "Each table must keep its own primary key. Got ${jsonencode(module.ots[0].table_primary_keys)}."
  }
}
