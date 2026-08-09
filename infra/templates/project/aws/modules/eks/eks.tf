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
      # Namespace-placement tenant isolation (#1012). Turn ON Kubernetes NetworkPolicy
      # ENFORCEMENT in the VPC CNI (starts the aws-network-policy-agent). Without this the
      # guardrail bundle's default-deny NetworkPolicy is a NO-OP on AWS — tenant namespaces
      # have no network isolation. The value is a QUOTED STRING per the addon config schema.
      # Requires VPC CNI >= 1.14.0 (satisfied by most_recent) and k8s >= 1.25 (Fabric runs 1.33+).
      configuration_values = jsonencode({
        enableNetworkPolicy = "true"
      })
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

  # #1987: the project's extra ingress allow-list is MERGED in rather than replacing the fixed
  # rule, so an empty list (the default) produces a byte-identical plan. One rule, carrying every
  # permitted CIDR — the upstream module maps `cidr_blocks` onto a single aws_security_group_rule,
  # so listing them together avoids a rule-per-CIDR whose addresses churn when the list is reordered.
  node_security_group_additional_rules = merge(
    {
      ingress_self_all = {
        description = "Node to node all ports/protocols"
        protocol    = "-1"
        from_port   = 0
        to_port     = 0
        type        = "ingress"
        self        = true
      }
    },
    length(var.allowed_cidr_blocks) > 0 ? {
      ingress_operator_allow_list = {
        description = "Operator allow-list (project network allowed_cidr_blocks)"
        protocol    = "-1"
        from_port   = 0
        to_port     = 0
        type        = "ingress"
        cidr_blocks = var.allowed_cidr_blocks
      }
    } : {},
  )

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

      subnet_ids            = var.subnet_ids
      capacity_type         = var.eks_ng_capacity_type
      create_security_group = true
      security_group_name   = "${var.eks_cluster_name}-ng-sg"
    }
  }

  tags                          = var.eks_tags
  kms_key_enable_default_policy = var.kms_key_enable_default_policy
  kms_key_users                 = var.kms_key_users

  # The EKS SERVICE — not this module — owns the cluster's primary security group, so the module
  # tags it after creation with a separate `aws_ec2_tag` per key. That resource cannot be applied
  # safely: its create calls Read immediately, and the provider's not-found branch is guarded by
  # `!d.IsNewResource()` (internal/service/ec2/tag_gen.go), so a `DescribeTags` that has not yet
  # converged returns `tfresource.NewEmptyResultError` and becomes a FATAL apply error instead of
  # a retry. There is no read-path retry — `createTags`' 5-minute eventual-consistency retry only
  # covers AWS `.NotFound` codes on the WRITE — and the guard is unchanged in every provider
  # release including main, and in module v21.
  #
  #   Error: reading ec2 resource (sg-…) tag (Project): empty result
  #     with module.eks[0].module.eks.aws_ec2_tag.cluster_primary_security_group["Project"]
  #
  # Refs hashicorp/terraform-provider-aws#36444 (open, untriaged) and
  # terraform-aws-modules/terraform-aws-eks#3441 (closed unreproduced — same error, same key).
  # It reddened the aws full-bar nightly (#2098) and can fail a real customer apply at random.
  #
  # Dropping these tags costs nothing: the two SGs OpenTofu creates (`-sg`, `-ng-sg`) carry the
  # full set — including the `alethia:project-id` sweep handle — via the provider `default_tags`
  # in main.tf, and no check block, cost guard, sweeper path or E2E assertion reads a tag off the
  # primary SG. It also removes a false-RED: that SG can outlive `eks wait cluster-deleted` and
  # be reported as a network leak by scripts/e2e/aws-cleanup.sh.
  #
  # A bump to module v21 renames this to `create_primary_security_group_tags`; an unknown module
  # input is a hard error, so the rename cannot silently turn this back on.
  create_cluster_primary_security_group_tags = false
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
