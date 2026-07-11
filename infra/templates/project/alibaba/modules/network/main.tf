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

locals {
  # Carve one /20 vswitch per availability zone out of the VPC CIDR.
  zones = var.zone_ids
}

# VPC
resource "alicloud_vpc" "this" {
  vpc_name   = var.vpc_name
  cidr_block = var.network_cidr
  tags       = var.tags
}

# One vswitch (subnet) per availability zone.
resource "alicloud_vswitch" "this" {
  count = length(local.zones)

  vpc_id       = alicloud_vpc.this.id
  vswitch_name = "${var.vswitch_prefix}-${count.index}"
  cidr_block   = cidrsubnet(var.network_cidr, 4, count.index)
  zone_id      = local.zones[count.index]
  tags         = var.tags
}

# NAT gateway for outbound access (single, dev/test friendly).
resource "alicloud_nat_gateway" "this" {
  count = var.single_cloud_nat ? 1 : 0

  vpc_id           = alicloud_vpc.this.id
  nat_gateway_name = "ngw-${var.vpc_name}"
  vswitch_id       = alicloud_vswitch.this[0].id
  nat_type         = "Enhanced"
  tags             = var.tags
}

# Elastic IP bound to the NAT gateway.
resource "alicloud_eip_address" "nat" {
  count = var.single_cloud_nat ? 1 : 0

  address_name = "eip-${var.vpc_name}"
  tags         = var.tags
}

resource "alicloud_eip_association" "nat" {
  count = var.single_cloud_nat ? 1 : 0

  allocation_id = alicloud_eip_address.nat[0].id
  instance_id   = alicloud_nat_gateway.this[0].id
}

# SNAT entries so vswitch traffic egresses through the NAT gateway.
resource "alicloud_snat_entry" "this" {
  count = var.single_cloud_nat ? length(local.zones) : 0

  snat_table_id     = alicloud_nat_gateway.this[0].snat_table_ids
  source_vswitch_id = alicloud_vswitch.this[count.index].id
  snat_ip           = alicloud_eip_address.nat[0].ip_address

  depends_on = [alicloud_eip_association.nat]
}
