# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The EKS managed node groups: eks_workers, and one more group per extra_node_pools entry (#5534).
#
# ISOLATION PARITY (#1012). Every extra group carries every isolation control eks_workers has, from
# the ONE local below, so a pool cannot be cheaper because it is less isolated:
#
#   · IMDSv2 required with hop limit 1. With hop limit 2, any pod on the node can fetch the node IAM
#     role's credentials (ECR, ENI/EC2). The upstream module DEFAULTS to 2 when a group omits
#     metadata_options, which is why it is set here explicitly. The root's node_groups.tftest.hcl
#     asserts it for every group (run "every_extra_group_keeps_the_isolation_of_eks_workers").
#   · The same private subnets, and the same node security group (the module attaches its shared
#     node SG to every group; `create_security_group` / `security_group_name` on eks_workers are
#     inputs module v20 no longer reads, kept so that group's input is unchanged).
#   · The encrypted gp3 root volume, the IAM policy attachments (CNI policy plus
#     eks_node_additional_policies) and ebs_optimized, through eks_managed_node_group_defaults and
#     the local below.
#
# DEFAULTS. With node_labels = {} and no extra groups, eks_workers' input is exactly what it was
# before #5534: `labels` is null, as an omitted attribute was, and there are no taints.

locals {
  # Shared by eks_workers and every extra group.
  node_group_isolation = {
    iam_role_use_name_prefix = !var.allow_long_names
    ebs_optimized            = true

    # Namespace-placement tenant isolation (#1012). Hop limit 1 (the IMDSv2 PUT-response IP
    # TTL) means a token reply routed to a Pod on the pod network (one extra CNI hop) is
    # dropped — a tenant Pod CANNOT reach 169.254.169.254 to assume the node IAM role
    # (cluster-wide node creds: ECR, ENI/EC2). Host-network components (kubelet, aws-node,
    # kube-proxy) sit at 0 hops so IMDS still works for them. Workloads that need cloud
    # identity use IRSA/Pod Identity, never the node role. (Was 2 — which is exactly the
    # value AWS says to set only when you WANT Pods to reach IMDS.)
    metadata_options = {
      http_endpoint               = "enabled"
      http_tokens                 = "required"
      http_put_response_hop_limit = 1
      instance_metadata_tags      = "disabled"
    }

    subnet_ids = var.subnet_ids
  }

  eks_managed_node_groups = merge(
    {
      eks_workers = merge(local.node_group_isolation, {
        name         = "${var.eks_cluster_name}-ng"
        min_size     = var.eks_ng_min_size
        max_size     = var.eks_ng_max_size
        desired_size = var.eks_ng_desired_size

        capacity_type         = var.eks_ng_capacity_type
        create_security_group = true
        security_group_name   = "${var.eks_cluster_name}-ng-sg"

        # node_labels (#5534). Null when there are none, exactly as the omitted attribute was.
        labels = length(var.node_labels) > 0 ? var.node_labels : null
      })
    },
    {
      for name, g in var.extra_node_groups : name => merge(local.node_group_isolation, {
        name = g.name
        # The launch template is named after the group, not the key: a one-letter pool name would
        # give the module's default ("<key>-") a name prefix under the 3 characters EC2 requires.
        launch_template_name = g.name
        instance_types       = g.instance_types
        ami_type             = g.ami_type
        capacity_type        = g.capacity_type
        min_size             = g.min_size
        max_size             = g.max_size
        desired_size         = g.desired_size
        labels               = g.labels
        taints               = g.taints
      })
    },
  )
}

output "managed_node_groups" {
  description = "The input each EKS managed node group is built from, by group key (eks_workers and every extra_node_pools name). The root's tofu tests read it to hold every group to the isolation invariants."
  value       = local.eks_managed_node_groups
}

output "managed_node_group_render" {
  description = "Per EKS managed node group, the labels and taints the planned aws_eks_node_group carries."
  value = {
    for k, g in module.eks.eks_managed_node_groups : k => {
      labels = g.node_group_labels
      taints = g.node_group_taints
    }
  }
}
