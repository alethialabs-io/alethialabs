module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "20.31.6"

  iam_role_use_name_prefix = !var.allow_long_names

  cluster_name    = var.eks_cluster_name
  cluster_version = var.eks_cluster_version

  # Pin the auth mode explicitly rather than inheriting the upstream module default. Access
  # entries — the keyless cluster-access model that the runner's creator-admin grant rides on —
  # are only honored under API / API_AND_CONFIG_MAP. If the pinned module's default ever drifted
  # to CONFIG_MAP, every access entry would silently drop and the runner would 401 on the API
  # server after a green apply. Pinning fails that closed.
  authentication_mode = "API_AND_CONFIG_MAP"

  cluster_endpoint_private_access      = true
  cluster_endpoint_public_access       = true
  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs
  cluster_security_group_name          = "${var.eks_cluster_name}-sg"
  enable_irsa                          = true

  access_entries = local.merged_access_entries

  # Grant cluster-admin to the identity that RUNS the apply (the Alethia runner's short-lived
  # OIDC-federated principal — the platform assumed-role in managed mode, or the customer's
  # identity for a self-hosted runner). Without this the runner authenticates to the EKS API
  # (via the in-process `kube-token` exec-plugin) but is AUTHORIZED by nothing, so installing
  # ArgoCD / the add-ons 401s and the whole post-apply spine fails — a real product gap, not an
  # e2e-only concern. The module resolves an assumed-role SESSION ARN back to the underlying
  # role ARN (data.aws_iam_session_context), so the access entry is stable across sessions. This
  # is the keyless, short-lived cluster-access model (no static admin kubeconfig in state).
  enable_cluster_creator_admin_permissions = var.enable_creator_admin

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
      most_recent = true
      # Configure the CNI BEFORE the managed node group so nodes get the IRSA-backed
      # vpc-cni at join time. Without this, the node group can come up before the CNI is
      # reconciled and the vpc-cni/coredns add-ons never reach ACTIVE (20m timeout on a
      # fresh apply — reproduced on real EKS). Standard fix for terraform-aws-modules/eks.
      before_compute           = true
      service_account_role_arn = module.vpc_cni_irsa.iam_role_arn
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

  # The `tags` below tag the addon OBJECT itself; they do NOT reach the EBS volumes the CSI
  # controller provisions at runtime for PVCs — those are created via the AWS API by the driver,
  # not by OpenTofu, so provider default_tags never touch them. `controller.extraVolumeTags` is the
  # only lever that stamps the classification + sweep-handle tags (var.eks_tags, base tags already
  # winning) onto every dynamically-provisioned `pvc-*` volume, so a guarded sweeper can reclaim
  # them by environment.
  #
  # ⚠️ UNPROVEN until A0.3's cloud-side sweep-tag check is green (BYOC A1.2). Whether the volumes
  # actually carry these tags is only observable after a real apply with live PVCs — the AWS EBS-CSI
  # `controller.extraVolumeTags` Helm value is asserted upstream but has never been verified against
  # a real `pvc-*` volume in this program. This wires the driver config that SHOULD make it happen;
  # A0.3's cloud-side check on a Bound volume is what upgrades it from "wired" to "proven".
  # Fallback if extraVolumeTags turns out not to stamp: set the sweep tags via StorageClass
  # `parameters.tagSpecification_N` (per-StorageClass) or the driver's `--extra-tags` flag
  # (controller.additionalArgs) instead — both are driver-native tagging paths independent of the
  # addon configuration_values.
  configuration_values = jsonencode({
    controller = {
      extraVolumeTags = var.eks_tags
    }
  })

  tags = merge(
    var.eks_tags,
    tomap({ eks_addon = "ebs_csi" })
  )
}
