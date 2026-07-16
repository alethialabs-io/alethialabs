# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# Availability zones in the target region — the cluster spreads its vswitches
# across zones for HA. PLAN-OUT SAFETY (#621, the alibaba twin of the aws #608 flaw):
# under the runner's keyless RAM-OIDC provider, credentials resolve only at APPLY, so
# this data source is UNKNOWN at plan. Its ids may feed resource ATTRIBUTES (resolved at
# apply) but must never feed a count/for_each — the vswitch count below is the static
# `vswitch_count`, and zone assignment wraps via element() inside modules/network.
data "alicloud_zones" "available" {
  available_resource_creation = "VSwitch"
}

locals {
  # Discovered zone ids — VALUES only (apply-resolved). Consumers (kvstore zone pins,
  # the network module's zone assignment) may reference them as attributes; nothing may
  # derive a count/for_each from them (#621 — the plan-out-safety guard enforces this).
  zone_ids = data.alicloud_zones.available.zones[*].id
}

module "network" {
  source = "./modules/network"
  count  = var.provision_network ? 1 : 0

  vpc_name       = local.vpc_name
  network_cidr   = var.network_cidr
  vswitch_prefix = local.vswitch_prefix
  # Discovered zone IDS (values, apply-resolved); the COUNT stays plan-known.
  zone_ids      = local.zone_ids
  vswitch_count = var.vswitch_count

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
