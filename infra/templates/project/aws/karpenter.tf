resource "aws_iam_service_linked_role" "spot" {
  count            = var.ec2_spot_service_role ? 1 : 0
  aws_service_name = "spot.amazonaws.com"
}

## Karpenter
module "karpenter" {
  # `enable_karpenter` was the WRONG flag on its own (#1772): every argument below reads
  # module.eks[0], so `enable_karpenter = true, provision_eks = false` failed at PLAN with
  # "Invalid index … module.eks is empty tuple" instead of simply provisioning nothing. Karpenter
  # is a node autoscaler for a cluster — without one there is nothing for it to scale.
  count   = var.enable_karpenter && var.provision_eks ? 1 : 0
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "20.31.6"

  cluster_name              = try(module.eks[0].eks_cluster_id, null) != null ? module.eks[0].eks_cluster_id : ""
  queue_name                = local.karpenter_queue_name
  queue_managed_sse_enabled = true

  node_iam_role_arn    = try(module.eks[0].node_iam_role_arn, null) != null ? module.eks[0].node_iam_role_arn : ""
  create_node_iam_role = false

  irsa_oidc_provider_arn          = try(module.eks[0].oidc_provider_arn, null) != null ? module.eks[0].oidc_provider_arn : ""
  irsa_namespace_service_accounts = ["${local.karpenter_namespace}:karpenter"]
  create_iam_role                 = false
  iam_role_use_name_prefix        = false

  # Error: creating EKS Access Entry ResourceInUseException: The specified access entry resource is already in use on this cluster.
  create_access_entry = false
}


# The Karpenter NodePool the runner renders after the cluster is up (#5527). Nothing here builds an
# AWS resource: the NodePool is a Kubernetes object, so the values travel to the runner through the
# `karpenter_nodepool` output (outputs.tf) and packages/core/provisioner/karpenter.go applies them.
# They are gathered in one local so the output and its precondition read one value.
locals {
  karpenter_nodepool = {
    capacity_types      = var.karpenter_capacity_types
    architectures       = var.karpenter_architectures
    instance_categories = var.karpenter_instance_categories
    instance_families   = var.karpenter_instance_families
    cpu_limit           = var.karpenter_cpu_limit
    labels              = var.karpenter_node_labels
    taints              = var.karpenter_node_taints
  }

  # Families whose name starts with none of the chosen categories. Karpenter ANDs the two
  # requirements, so a family outside every category ("c7g" against the default ["t", "m"]) leaves
  # the NodePool with no instance type it can launch — a pool that looks healthy and never scales.
  karpenter_families_outside_categories = length(var.karpenter_instance_categories) == 0 ? [] : [
    for f in var.karpenter_instance_families : f
    if !anytrue([for c in var.karpenter_instance_categories : startswith(f, c)])
  ]
}
