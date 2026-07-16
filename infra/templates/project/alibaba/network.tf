# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Availability zones in the target region — the cluster spreads its vswitches
# across up to three zones for HA.
data "alicloud_zones" "available" {
  available_resource_creation = "VSwitch"
}

locals {
  # All zones the region offers for VSwitch creation. Discovered (unknown until apply) — but the
  # vswitch COUNT is NOT derived from its length: the module uses a plan-known static count
  # (var.subnet_count) and element()-indexes into this list, so a region with fewer zones wraps
  # instead of erroring. Counting off this data source's length would be unknown at plan under the
  # runner's deferred RAM-OIDC provider → "Invalid count argument" on `tofu plan -out` before apply
  # (the aws class of bug, #551/#608; guarded by check-templates-plan-safe.sh).
  zone_ids = data.alicloud_zones.available.zones[*].id
}

module "network" {
  source = "./modules/network"
  count  = var.provision_network ? 1 : 0

  vpc_name       = local.vpc_name
  network_cidr   = var.network_cidr
  vswitch_prefix = local.vswitch_prefix
  zone_ids       = local.zone_ids

  single_cloud_nat = var.single_cloud_nat

  tags = local.common_tags
}

locals {
  # Vswitch ids used by ACK / RDS / KVStore — from the new VPC when greenfield,
  # otherwise from the existing VPC's vswitches (brownfield).
  vswitch_ids = var.provision_network ? try(module.network[0].vswitch_ids, []) : data.alicloud_vswitches.existing[0].ids
}

# Brownfield: discover vswitches belonging to an existing VPC.
data "alicloud_vswitches" "existing" {
  count  = var.provision_network ? 0 : 1
  vpc_id = var.network_id
}
