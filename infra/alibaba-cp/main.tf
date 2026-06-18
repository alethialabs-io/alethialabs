# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# alethialabs.io control plane on Alibaba Cloud — a single Yitian 710 ARM (g8y)
# ECS instance running the same self-host bundle as the other hosts.

locals {
  tags = {
    project = "alethia"
    role    = "control-plane"
    managed = "terraform"
  }
}

# Ubuntu 24.04 LTS, ARM64, from the system image catalogue.
data "alicloud_images" "ubuntu" {
  owners       = "system"
  architecture = "arm64"
  name_regex   = "^ubuntu_24_04_arm64"
  most_recent  = true
}

# Zones that actually offer the ARM instance type (used when zone_id is unset).
data "alicloud_instance_types" "arm" {
  instance_type        = var.instance_type
  availability_zone    = var.zone_id != "" ? var.zone_id : null
  instance_type_family = "ecs.g8y"
}

resource "alicloud_vpc" "cp" {
  vpc_name   = "alethia-cp"
  cidr_block = "10.30.0.0/16"
  tags       = local.tags
}

resource "alicloud_vswitch" "cp" {
  vswitch_name = "alethia-cp"
  vpc_id       = alicloud_vpc.cp.id
  cidr_block   = "10.30.1.0/24"
  zone_id      = var.zone_id != "" ? var.zone_id : data.alicloud_instance_types.arm.instance_types[0].availability_zones[0]
  tags         = local.tags
}

resource "alicloud_security_group" "cp" {
  security_group_name = "alethia-cp"
  vpc_id              = alicloud_vpc.cp.id
  tags                = local.tags
}

resource "alicloud_security_group_rule" "ssh" {
  count             = length(var.ssh_allowed_cidrs)
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "22/22"
  security_group_id = alicloud_security_group.cp.id
  cidr_ip           = var.ssh_allowed_cidrs[count.index]
}

resource "alicloud_security_group_rule" "http" {
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "80/80"
  security_group_id = alicloud_security_group.cp.id
  cidr_ip           = "0.0.0.0/0"
}

resource "alicloud_security_group_rule" "https" {
  type              = "ingress"
  ip_protocol       = "tcp"
  port_range        = "443/443"
  security_group_id = alicloud_security_group.cp.id
  cidr_ip           = "0.0.0.0/0"
}

resource "alicloud_ecs_key_pair" "cp" {
  key_pair_name = "alethia-cp"
  public_key    = var.ssh_public_key
  tags          = local.tags
}

resource "alicloud_instance" "cp" {
  instance_name   = "alethia-cp"
  instance_type   = var.instance_type
  image_id        = data.alicloud_images.ubuntu.images[0].id
  vswitch_id      = alicloud_vswitch.cp.id
  security_groups = [alicloud_security_group.cp.id]
  key_name        = alicloud_ecs_key_pair.cp.key_pair_name

  system_disk_category = "cloud_essd"
  system_disk_size     = var.system_disk_size

  # Public IPv4 (pay-by-traffic, minimal bandwidth — Caddy needs inbound only).
  internet_max_bandwidth_out = 5
  internet_charge_type       = "PayByTraffic"

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    repo_url = var.repo_url
  })

  tags = local.tags
}

# DNS — unproxied so Caddy's ACME challenge reaches the box directly.
resource "cloudflare_record" "apex_a" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "A"
  content = alicloud_instance.cp.public_ip
  proxied = false
  ttl     = 300
}

resource "cloudflare_record" "www_a" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "A"
  content = alicloud_instance.cp.public_ip
  proxied = false
  ttl     = 300
}
