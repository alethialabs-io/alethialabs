module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "20.31.6"

  iam_role_use_name_prefix = !var.allow_long_names

  cluster_name                         = var.eks_cluster_name
  cluster_version                      = var.eks_cluster_version
  cluster_endpoint_private_access      = true
  cluster_endpoint_public_access       = true
  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs
  cluster_security_group_name          = "${var.eks_cluster_name}-sg"
  enable_irsa                          = true

  access_entries = local.merged_access_entries

  ## Control plane logging
  create_cloudwatch_log_group            = true
  cluster_enabled_log_types              = var.cluster_enabled_log_types
  cloudwatch_log_group_retention_in_days = var.cluster_log_retention_in_days

  cluster_addons = {
    coredns = {
      most_recent = true
    }
    kube-proxy = {
      most_recent = true
    }
    vpc-cni = {
      most_recent               = true
      service_account_role_arn  = module.vpc_cni_irsa.iam_role_arn
    }
  }

  cluster_security_group_additional_rules = {
    egress_nodes_ephemeral_ports_tcp = {
      description                = "To node 1025-65535"
      protocol                   = "tcp"
      from_port                  = 1025
      to_port                    = 65535
      type                       = "egress"
      source_node_security_group = true
    }
  }

  node_security_group_additional_rules = {
    ingress_self_all = {
      description = "Node to node all ports/protocols"
      protocol    = "-1"
      from_port   = 0
      to_port     = 0
      type        = "ingress"
      self        = true
    }
  }

  cluster_ip_family          = "ipv4"
  create_cni_ipv6_iam_policy = false

  vpc_id                   = var.vpc_id
  subnet_ids               = var.subnet_ids
  control_plane_subnet_ids = var.control_plane_subnet_ids


  # EKS Managed Node Group(s)

  eks_managed_node_group_defaults = {
    ami_type       = var.eks_ami_type
    disk_size      = var.eks_disk_size
    instance_types = var.eks_instance_types

    iam_role_attach_cni_policy = true

    iam_role_additional_policies = var.eks_node_additional_policies

    block_device_mappings = {
      xvda = {
        device_name = "/dev/xvda"
        ebs = {
          volume_size           = var.eks_disk_size
          volume_type           = var.eks_volume_type
          iops                  = var.eks_volume_iops
          throughput            = 150
          encrypted             = true
          delete_on_termination = true
        }
      }
    }
  }

  eks_managed_node_groups = {
    eks_workers = {
      iam_role_use_name_prefix = !var.allow_long_names

      name         = "${var.eks_cluster_name}-ng"
      min_size     = var.eks_ng_min_size
      max_size     = var.eks_ng_max_size
      desired_size = var.eks_ng_desired_size

      ebs_optimized = true

      metadata_options = {
        http_endpoint               = "enabled"
        http_tokens                 = "required"
        http_put_response_hop_limit = 2
        instance_metadata_tags      = "disabled"
      }

      subnet_ids            = var.subnet_ids
      capacity_type         = var.eks_ng_capacity_type
      create_security_group = true
      security_group_name   = "${var.eks_cluster_name}-ng-sg"
    }
  }

  tags                          = var.eks_tags
  kms_key_enable_default_policy = var.kms_key_enable_default_policy
  kms_key_users                 = var.kms_key_users

}

data "aws_eks_addon_version" "ebs_csi" {
  addon_name         = "aws-ebs-csi-driver"
  kubernetes_version = module.eks.cluster_version
  most_recent        = true
}

resource "aws_eks_addon" "ebs-csi" {
  cluster_name             = module.eks.cluster_name
  addon_name               = "aws-ebs-csi-driver"
  addon_version            = data.aws_eks_addon_version.ebs_csi.version
  service_account_role_arn = module.irsa-ebs-csi.iam_role_arn
  tags = merge(
    var.eks_tags,
    tomap({ eks_addon = "ebs_csi" })
  )
}
