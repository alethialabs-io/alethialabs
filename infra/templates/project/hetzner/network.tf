# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

locals {
  # Carve a /24 node subnet out of the network CIDR for the servers' private IPs.
  node_subnet_cidr = cidrsubnet(var.network_cidr, 24 - tonumber(split("/", var.network_cidr)[1]), 0)

  # Deterministic private IPs. Hetzner reserves the first host of a subnet and
  # the .1 gateway, so we start control planes at .101 and workers at .201.
  control_plane_private_ips = [
    for i in range(var.control_plane_count) : cidrhost(local.node_subnet_cidr, i + 101)
  ]
  worker_private_ips = [
    for i in range(var.worker_count) : cidrhost(local.node_subnet_cidr, i + 201)
  ]
}

# Private network the whole cluster attaches to.
resource "hcloud_network" "this" {
  name     = local.cluster_name
  ip_range = var.network_cidr
  labels = {
    cluster = local.cluster_name
  }
}

resource "hcloud_network_subnet" "nodes" {
  network_id   = hcloud_network.this.id
  type         = "cloud"
  network_zone = data.hcloud_location.selected.network_zone
  ip_range     = local.node_subnet_cidr
}

# Pre-allocate public IPv4s so the control-plane public IPs are known BEFORE the
# machine config / cert SANs are rendered — this breaks the server<->config
# dependency cycle (the same approach the reference module uses).
resource "hcloud_primary_ip" "control_plane_ipv4" {
  count       = var.control_plane_count
  name        = "${local.cluster_name}-cp-${count.index + 1}-ipv4"
  datacenter  = local.region_datacenter
  type        = "ipv4"
  auto_delete = false
  labels = {
    cluster = local.cluster_name
    role    = "control-plane"
  }
}

resource "hcloud_primary_ip" "worker_ipv4" {
  count       = var.worker_count
  name        = "${local.cluster_name}-worker-${count.index + 1}-ipv4"
  datacenter  = local.region_datacenter
  type        = "ipv4"
  auto_delete = false
  labels = {
    cluster = local.cluster_name
    role    = "worker"
  }
}

locals {
  control_plane_public_ips = [for ip in hcloud_primary_ip.control_plane_ipv4 : ip.ip_address]
  control_plane_public_ip  = local.control_plane_public_ips[0]
  worker_public_ips        = [for ip in hcloud_primary_ip.worker_ipv4 : ip.ip_address]
}

# Firewall: allow Talos apid (50000/50001), the Kubernetes API (6443), and all
# intra-cluster traffic on the private network.
resource "hcloud_firewall" "this" {
  name = local.cluster_name
  labels = {
    cluster = local.cluster_name
  }

  rule {
    description = "Talos apid"
    direction   = "in"
    protocol    = "tcp"
    port        = "50000"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Talos apid (trustd)"
    direction   = "in"
    protocol    = "tcp"
    port        = "50001"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Kubernetes API server"
    direction   = "in"
    protocol    = "tcp"
    port        = "6443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Intra-cluster TCP (private network)"
    direction   = "in"
    protocol    = "tcp"
    port        = "any"
    source_ips  = [var.network_cidr]
  }

  rule {
    description = "Intra-cluster UDP (private network)"
    direction   = "in"
    protocol    = "udp"
    port        = "any"
    source_ips  = [var.network_cidr]
  }

  rule {
    description = "Intra-cluster ICMP (private network)"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = [var.network_cidr]
  }
}
