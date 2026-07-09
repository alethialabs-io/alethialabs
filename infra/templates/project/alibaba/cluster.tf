# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

module "cluster" {
  source = "./modules/cluster"
  count  = var.provision_ack ? 1 : 0

  depends_on = [module.network]

  cluster_name    = local.ack_name
  cluster_version = var.ack_cluster_version

  vswitch_ids = local.vswitch_ids

  instance_types    = var.ack_instance_types
  node_min_size     = var.ack_node_min_size
  node_max_size     = var.ack_node_max_size
  node_desired_size = var.ack_node_desired_size
  disk_size_gb      = var.ack_disk_size_gb

  tags = local.common_tags
}
