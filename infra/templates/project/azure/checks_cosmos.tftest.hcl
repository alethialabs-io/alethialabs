# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the canvas's `point_in_time_recovery` switch buys CONTINUOUS BACKUP on the Cosmos DB
# account, and buys nothing else.
#
# Until #1838 it bought the wrong product. `buildCosmosDBCollections` answered the switch with
# `analytical_storage_enabled = true` — Synapse Link analytical (column) storage, a separately
# billed feature that is not a backup — while modules/cosmos-db declared the account with no
# `backup {}` block at all, so continuous backup was never requested by anything. A user who asked
# for recoverability got an extra bill and no recoverability, and every text-reading guard saw a
# carried switch.
#
# This file is at the TEMPLATE ROOT deliberately: `.tftest.hcl` under `modules/**` is silently
# skipped by `tofu test`, so a suite written next to the module would be dead on arrival.
#
# Providers are mocked, so this needs no credentials and runs on any PR.

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-0000-0000-0000000000aa"
      subscription_id = "00000000-0000-0000-0000-000000000001"
      client_id       = "00000000-0000-0000-0000-0000000000bb"
      object_id       = "00000000-0000-0000-0000-0000000000cc"
    }
  }

  # Azure resource IDs are PARSED by the provider before any API call, and the mock's generated
  # strings parse into zero segments. Every id below only has to be well-formed.
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/virtualNetworks/mock/subnets/mock" }
  }
  mock_resource "azurerm_network_security_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/networkSecurityGroups/mock" }
  }
  mock_resource "azurerm_route_table" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.Network/routeTables/mock" }
  }
  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.KeyVault/vaults/mock"
      vault_uri = "https://mock.vault.azure.net/"
    }
  }
  mock_resource "azurerm_cosmosdb_account" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/mock/providers/Microsoft.DocumentDB/databaseAccounts/mock" }
  }
}

mock_provider "azuread" {}
mock_provider "random" {}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000001"
  location        = "westeurope"
  environment     = "production"
  project_name    = "alethia-nl"

  # A NoSQL-only project. The cluster is orthogonal to Cosmos and only makes the plan bigger.
  provision_aks    = false
  create_cosmos_db = true
}

################################################################################
# 1. The switch ON — continuous backup, on the free tier
################################################################################

run "point_in_time_recovery_puts_the_account_in_continuous_backup" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "ledger", partition_key = "/tenant", point_in_time_recovery = true },
    ]
  }

  # The derivation, at the root. `anytrue` over the containers is what reconciles a per-table switch
  # with an account-level feature, and getting it backwards is silent.
  assert {
    condition     = local.cosmos_point_in_time_recovery && local.cosmos_backup_type == "Continuous"
    error_message = "A container asking for point-in-time recovery must put the account in Continuous backup mode."
  }

  # And the resource actually carries it. This half is read off
  # `azurerm_cosmosdb_account.this.backup[0]`, so deleting the `backup` block — the exact state the
  # template shipped in — reds this even though the local above would still be right.
  assert {
    condition     = module.cosmos_db[0].backup_mode == "Continuous"
    error_message = "The planned Cosmos DB account must declare backup { type = \"Continuous\" }; a local that nothing reads restores nothing."
  }

  # Continuous7Days is free. #1838 was a switch that quietly bought a billable feature, so the
  # default must not be the billed 30-day tier.
  assert {
    condition     = module.cosmos_db[0].backup_tier == "Continuous7Days"
    error_message = "Point-in-time recovery must default to the free Continuous7Days tier, not the billed 30-day one."
  }
}

# The tier is a knob, not a constant — pinned so the free default cannot be mistaken for the only
# reachable value and quietly hard-coded.
run "the_thirty_day_tier_is_reachable_when_asked_for" {
  command = plan

  variables {
    cosmos_db_continuous_backup_tier = "Continuous30Days"
    cosmos_db_collections = [
      { name = "ledger", point_in_time_recovery = true },
    ]
  }

  assert {
    condition     = module.cosmos_db[0].backup_tier == "Continuous30Days"
    error_message = "cosmos_db_continuous_backup_tier must reach the account's backup block."
  }
}

################################################################################
# 2. The switch OFF — Periodic, and no tier
################################################################################

# Without this the suite would pass on a template that hard-wired Continuous for everyone, which is
# the same class of defect as hard-wiring the wrong feature: the switch would decide nothing.
run "no_point_in_time_recovery_leaves_the_account_on_periodic_backup" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "ledger", partition_key = "/tenant" },
    ]
  }

  assert {
    condition     = !local.cosmos_point_in_time_recovery && local.cosmos_backup_type == "Periodic"
    error_message = "With no container asking for it, the account must stay on Cosmos's default Periodic backup."
  }

  assert {
    condition     = module.cosmos_db[0].backup_mode == "Periodic"
    error_message = "The planned account must declare Periodic backup when nothing asked for point-in-time restore."
  }

  # `tier` is only legal in Continuous mode; leaving a stale value on the Periodic path is an apply
  # error, not a cosmetic one.
  #
  # Asserted on the LOCAL, not on `module.cosmos_db[0].backup_tier`. `backup.tier` is Optional AND
  # Computed in the azurerm schema, so an unset tier is unknown at plan and the mock provider fills
  # it with a generated string — the resource-side read can only ever prove a tier that WAS set (the
  # two runs above), never that one was not. Asserting it here anyway would fail against a correct
  # template.
  assert {
    condition     = local.cosmos_backup_tier == null
    error_message = "A retention tier must not be set on a Periodic account."
  }
}

################################################################################
# 3. Point-in-time recovery is not Synapse Link
################################################################################

# The actual #1838 defect, stated as an invariant: the two features are INDEPENDENT axes of the
# container shape. Turning recovery on must not turn analytical storage on, and — the other
# direction, which keeps the fix from being "delete analytical storage" — asking for Synapse Link
# must still be possible without asking for a backup mode change.
run "recovery_and_analytical_storage_are_independent" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "warehouse", analytical_storage_enabled = true },
    ]
  }

  assert {
    condition     = local.cosmos_backup_type == "Periodic"
    error_message = "Synapse analytical storage is not a backup: asking for it must not change the account's backup mode."
  }

  assert {
    condition     = alltrue([for c in var.cosmos_db_collections : c.point_in_time_recovery == false])
    error_message = "analytical_storage_enabled must not imply point_in_time_recovery — they are separate, separately-billed features."
  }
}

# A mixed account: one container asks for recovery, another asks for Synapse Link. Continuous backup
# covers the whole account (that is how Cosmos sells it), and the analytical-storage container must
# not be what decided it.
run "one_recovering_container_covers_the_account_without_pulling_in_synapse" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "ledger", point_in_time_recovery = true },
      { name = "warehouse", analytical_storage_enabled = true },
    ]
  }

  assert {
    condition     = module.cosmos_db[0].backup_mode == "Continuous"
    error_message = "One container asking for point-in-time recovery must put the whole account in Continuous mode."
  }

  assert {
    condition     = length([for c in var.cosmos_db_collections : c if c.analytical_storage_enabled]) == 1
    error_message = "Exactly the container that asked for Synapse Link may have it; the recovery switch must not add another."
  }
}

################################################################################
# 4. Global replicas (#2158) — per-table lists, one account-level union
################################################################################
#
# Cosmos replicates per ACCOUNT (geo_location blocks), the canvas collects the list per table, so
# the account gets the UNION of every table's list — the point_in_time_recovery shape again. Two
# things earn these runs beyond the derivation: serverless is single-region-only, so replicas must
# switch the account OFF EnableServerless (a billing-model change, and a replacement on an existing
# account — asserted so it can never happen by accident from a default); and every assertion reads
# the RESOURCE's own geo_location/capabilities (through outputs projected off them), because a
# dynamic block that silently emits nothing would pass any assertion on the variable.

run "global_replicas_union_reaches_the_account_and_drops_serverless" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "ledger", global_replicas = ["northeurope", "francecentral"] },
      { name = "audit", global_replicas = ["northeurope", "germanywestcentral"] },
    ]
  }

  # The union, at the root: distinct across tables, primary region excluded.
  assert {
    condition     = local.cosmos_replica_regions == tolist(["northeurope", "francecentral", "germanywestcentral"])
    error_message = "The account's replica set must be the distinct union of every table's list; got ${jsonencode(local.cosmos_replica_regions)}."
  }

  # On the resource: primary at 0, each replica present with a real failover priority.
  assert {
    condition = (
      module.cosmos_db[0].geo_locations["westeurope"] == 0 &&
      length(module.cosmos_db[0].geo_locations) == 4 &&
      alltrue([for r in ["northeurope", "francecentral", "germanywestcentral"] : lookup(module.cosmos_db[0].geo_locations, r, -1) > 0])
    )
    error_message = "Every chosen replica region must be planned as a geo_location with the primary at priority 0; got ${jsonencode(module.cosmos_db[0].geo_locations)}."
  }

  # The deliberate flip: replicas ⇒ provisioned throughput, because serverless is single-region.
  assert {
    condition     = module.cosmos_db[0].serverless == false
    error_message = "An account with replica regions must NOT be planned serverless — serverless Cosmos accounts are single-region-only, so the capability would make the plan unappliable."
  }
}

# No replicas anywhere — the status quo must be byte-identical to before #2158: one region,
# serverless capability present.
run "no_replicas_keeps_the_single_region_serverless_account" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "ledger" },
      { name = "audit", global_replicas = [] },
    ]
  }

  assert {
    condition     = length(local.cosmos_replica_regions) == 0
    error_message = "Tables with no replica request must derive an empty union; got ${jsonencode(local.cosmos_replica_regions)}."
  }

  assert {
    condition = (
      length(module.cosmos_db[0].geo_locations) == 1 &&
      lookup(module.cosmos_db[0].geo_locations, "westeurope", -1) == 0
    )
    error_message = "With no replicas the account must keep exactly its primary region; got ${jsonencode(module.cosmos_db[0].geo_locations)}."
  }

  assert {
    condition     = module.cosmos_db[0].serverless == true
    error_message = "With no replicas the account must stay serverless — flipping an existing account's billing model on nobody's request is the exact surprise the human sign-off ruled out."
  }
}

# A table naming the PRIMARY region as a replica: deduplicated, not doubled. Repeating the primary
# as a second geo_location would collide on the region and fail at apply.
run "a_replica_list_naming_the_primary_region_is_deduplicated" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "ledger", global_replicas = ["westeurope", "northeurope"] },
    ]
  }

  assert {
    condition     = local.cosmos_replica_regions == tolist(["northeurope"])
    error_message = "The primary region must be filtered out of the replica union — it is already the priority-0 geo_location; got ${jsonencode(local.cosmos_replica_regions)}."
  }

  assert {
    condition = (
      length(module.cosmos_db[0].geo_locations) == 2 &&
      lookup(module.cosmos_db[0].geo_locations, "westeurope", -1) == 0 &&
      lookup(module.cosmos_db[0].geo_locations, "northeurope", -1) == 1
    )
    error_message = "Primary at 0, the one real replica at 1 — nothing doubled; got ${jsonencode(module.cosmos_db[0].geo_locations)}."
  }
}

# One `partition_key` field feeds two clouds with incompatible rules: DynamoDB takes a bare attribute
# name, Cosmos takes a JSON path that must start with `/`. The console labels the field "Hash key" —
# DynamoDB's own word — so `pk` is the obvious thing for a customer to type, and it is correct on
# aws. On azure it produced, on the first full bar to ever reach Cosmos (32836351919):
#
#   The partition key component definition path 'pk' could not be accepted, failed near position '0'
#
# This is the direction that catches a regression in the rooting.
run "a_bare_partition_key_is_rooted_into_a_path" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "items", partition_key = "pk" },
    ]
  }

  assert {
    condition     = module.cosmos_db[0].partition_key_paths["items"] == tolist(["/pk"])
    error_message = "A bare partition key must be rooted to a Cosmos path — Cosmos rejects 'pk' at apply; got ${jsonencode(module.cosmos_db[0].partition_key_paths["items"])}."
  }
}

# The other direction, and the one a naive fix breaks: an ALREADY-rooted path must pass through
# untouched. Prefixing unconditionally would yield `//id`, which Cosmos rejects for the same reason —
# turning a bug that only bit new users into one that bit existing ones too.
run "an_already_rooted_partition_key_is_left_alone" {
  command = plan

  variables {
    cosmos_db_collections = [
      { name = "orders", partition_key = "/tenant" },
    ]
  }

  assert {
    condition     = module.cosmos_db[0].partition_key_paths["orders"] == tolist(["/tenant"])
    error_message = "An already-rooted path must not be prefixed again (`//tenant` is as invalid as `tenant`); got ${jsonencode(module.cosmos_db[0].partition_key_paths["orders"])}."
  }
}
