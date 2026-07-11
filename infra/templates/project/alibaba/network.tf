# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Availability zones in the target region — the cluster spreads its vswitches
# across up to three zones for HA.
data "alicloud_zones" "available" {
  available_resource_creation = "VSwitch"
}

locals {
  zone_ids = slice(
    data.alicloud_zones.available.zones[*].id,
    0,
    min(3, length(data.alicloud_zones.available.zones)),
  )
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
