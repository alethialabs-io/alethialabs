module "eks" {
  source = "./modules/eks"
  count  = var.provision_eks ? 1 : 0

  providers = {
    aws = aws
  }

  aws_region  = var.region
  environment = var.environment

  eks_cluster_version = var.eks_cluster_version
  allowed_cidr_blocks = var.vpc_allowed_cidr_blocks
  eks_cluster_name    = local.eks_name

  cluster_admins = var.eks_cluster_admins
  access_entries = var.eks_access_entries

  cluster_endpoint_public_access_cidrs = var.cluster_endpoint_public_access_cidrs

  cluster_log_retention_in_days = var.cluster_log_retention_in_days

  vpc_id                   = try(module.common_vpc[0].vpc_id, null) != null ? module.common_vpc[0].vpc_id : var.vpc_id
  subnet_ids               = try(module.common_vpc[0].private_subnets, null) != null ? module.common_vpc[0].private_subnets : var.vpc_private_subnet_ids
  control_plane_subnet_ids = try(module.common_vpc[0].public_subnets, null) != null ? module.common_vpc[0].public_subnets : var.vpc_public_subnet_ids


  eks_ami_type       = var.eks_ami_type
  eks_disk_size      = var.eks_disk_size
  eks_instance_types = var.eks_instance_types
  eks_volume_type    = var.eks_volume_type
  eks_volume_iops    = var.eks_volume_iops

  eks_ng_min_size      = var.eks_ng_min_size
  eks_ng_max_size      = var.eks_ng_max_size
  eks_ng_desired_size  = var.eks_ng_desired_size
  eks_ng_capacity_type = var.eks_ng_capacity_type

  # The node-pool contract (#5534): labels for eks_workers, and the extra node groups, both from
  # local.nodepool_contract_render (below, in this file).
  node_labels       = local.nodepool_contract_render.default.labels
  extra_node_groups = local.eks_extra_node_groups

  eks_tags = local.aws_default_tags

  kms_key_users        = var.eks_kms_key_users
  secrets_kms_key_arns = length(local.secrets_kms_key_arns) > 0 ? local.secrets_kms_key_arns : ["*"]
  secret_resource_arns = local.eso_secret_arns

  allow_long_names = var.allow_long_names

  external_dns_zone_id = try(module.route53[0].zone_id, null) != null ? module.route53[0].zone_id : var.dns_hosted_zone
}

################################################################################
# Node labels, taints and extra EKS managed node groups (#5534)
#
# Both halves live in this file, not a file of their own, because gen-template-knobs.mjs attributes
# a root variable to a component by the root FILE that reads it, and eks.tf is the cluster's.
################################################################################

# ── The node-pool contract's render, copied VERBATIM from
#    packages/core/cloud/testdata/nodepool/reference/render.tf. Do not edit it here.
#
# What the node-pool contract RENDERS (#5533): the labels and taints each pool's nodes carry. Every
# cloud lane copies this file into its template unchanged, builds its pools' labels and taints FROM
# `local.nodepool_contract_render`, and maps only the spelling (variables.tf says how). The
# reference tftest's `assert` blocks pin the output for the acceptance cases, and every lane carries
# those asserts, so the merge rules, the alethia.io/pool label and the arm64 platform taint come out
# the same on every cloud.
#
# The key `default` is the default pool, which is why `default` is a reserved pool name. Taints are
# objects with `value = ""` when none was set. The contract refuses an empty value, so "" can only
# mean "no value".

locals {
  nodepool_contract_render = merge(
    {
      default = {
        labels = var.node_labels
        taints = []
      }
    },
    {
      for p in var.extra_node_pools : p.name => {
        labels = merge(var.node_labels, p.labels, { "alethia.io/pool" = p.name })
        taints = concat(
          [
            for t in var.node_taints : { key = t.key, value = t.value == null ? "" : t.value, effect = t.effect }
            if !contains([for pt in p.taints : "${pt.key}:${pt.effect}"], "${t.key}:${t.effect}")
          ],
          [for t in p.taints : { key = t.key, value = t.value == null ? "" : t.value, effect = t.effect }],
          p.arch == "arm64" ? [{ key = "alethia.io/arch", value = "arm64", effect = "NoSchedule" }] : [],
        )
      }
    },
  )
}

output "nodepool_contract_render" {
  description = "Per pool (the default pool under `default`), the labels and taints its nodes carry under the node-pool contract (#5533)."
  value       = local.nodepool_contract_render
}

# ── The AWS mapping of that render.
#
# node_labels, node_taints and extra_node_pools on EKS (#5534): the node-pool contract's render
# (above) mapped to what an EKS managed node group
# takes. The LABELS and TAINTS come from local.nodepool_contract_render and nowhere else, so the
# render the contract's tests assert is the render the node groups get. This section maps spelling only:
#
#   · taint effects: NoSchedule → NO_SCHEDULE, PreferNoSchedule → PREFER_NO_SCHEDULE,
#     NoExecute → NO_EXECUTE. A taint with no value is null (the render spells it "").
#   · capacity_type: on-demand → ON_DEMAND, spot → SPOT.
#   · desired_size: min_size when it is left out.
#   · ami_type: the same OS family as eks_workers (eks_ami_type), for the pool's architecture and
#     for whether its instance type carries an NVIDIA GPU (local.eks_ami_families). The OS follows
#     eks_workers on purpose: Bottlerocket's read-only root and enforcing SELinux, and FIPS, are
#     controls an extra pool may not have fewer of than the default pool. So a FIPS cluster's arm64
#     pool gets BOTTLEROCKET_ARM_64_FIPS, never the non-FIPS AMI, and a combination with no AMI
#     (a GPU pool on FIPS Bottlerocket, an arm64 GPU pool on AL2) is refused at plan by
#     extra_node_pools' validation (variables.tf), as is an eks_ami_type outside the table (an arm64,
#     Windows or CUSTOM default group).
#   · name: "<cluster>-<pool>", shortened with a digest of the cluster name when it would pass the
#     36 characters an EKS node group name prefix allows (the module appends "-" and EKS a suffix).
#
# modules/eks/node_groups.tf builds the groups from local.eks_extra_node_groups below and gives
# every one the isolation controls of eks_workers.

locals {
  eks_taint_effects = {
    NoSchedule       = "NO_SCHEDULE"
    PreferNoSchedule = "PREFER_NO_SCHEDULE"
    NoExecute        = "NO_EXECUTE"
  }

  # The AMI type for an extra node group, by eks_ami_type's OS family, then arch, then cpu/gpu. null
  # means no EKS AMI exists for that combination. A family absent from the table (an arm64, Windows
  # or CUSTOM eks_ami_type) is refused for extra pools, by extra_node_pools' validation in
  # variables.tf, which reads these two tables.
  eks_ami_family_of = {
    BOTTLEROCKET_x86_64        = "bottlerocket"
    BOTTLEROCKET_x86_64_NVIDIA = "bottlerocket"
    BOTTLEROCKET_x86_64_FIPS   = "bottlerocket_fips"
    AL2023_x86_64_STANDARD     = "al2023"
    AL2023_x86_64_NVIDIA       = "al2023"
    AL2023_x86_64_NEURON       = "al2023"
    AL2_x86_64                 = "al2"
    AL2_x86_64_GPU             = "al2"
  }
  eks_ami_families = {
    bottlerocket = {
      amd64 = { cpu = "BOTTLEROCKET_x86_64", gpu = "BOTTLEROCKET_x86_64_NVIDIA" }
      arm64 = { cpu = "BOTTLEROCKET_ARM_64", gpu = "BOTTLEROCKET_ARM_64_NVIDIA" }
    }
    bottlerocket_fips = {
      amd64 = { cpu = "BOTTLEROCKET_x86_64_FIPS", gpu = null }
      arm64 = { cpu = "BOTTLEROCKET_ARM_64_FIPS", gpu = null }
    }
    al2023 = {
      amd64 = { cpu = "AL2023_x86_64_STANDARD", gpu = "AL2023_x86_64_NVIDIA" }
      arm64 = { cpu = "AL2023_ARM_64_STANDARD", gpu = "AL2023_ARM_64_NVIDIA" }
    }
    al2 = {
      amd64 = { cpu = "AL2_x86_64", gpu = "AL2_x86_64_GPU" }
      arm64 = { cpu = "AL2_ARM_64", gpu = null }
    }
  }

  # NVIDIA GPU instance types: g4dn, g5, g5g, g6, g6e, gr6, p3, p4d, p5, ... (g4ad is AMD, and takes
  # the ordinary AMI).
  eks_nvidia_instance_type = "^(g[0-9]+[a-z]*|gr[0-9]+[a-z]*|p[0-9]+[a-z]*)[.]"

  # Each extra pool's AMI type. Never null: extra_node_pools' validation refuses a pool with no AMI.
  eks_extra_ami_types = {
    for p in var.extra_node_pools : p.name => try(local.eks_ami_families[local.eks_ami_family_of[var.eks_ami_type]][p.arch][
      can(regex(local.eks_nvidia_instance_type, p.instance_type)) && !startswith(p.instance_type, "g4ad.") ? "gpu" : "cpu"
    ], null)
  }

  # The longest name an EKS node group's name prefix may carry before the module's "-".
  eks_node_group_name_max = 36

  eks_extra_node_groups = {
    for p in var.extra_node_pools : p.name => {
      name = (
        length("${local.eks_name}-${p.name}") <= local.eks_node_group_name_max
        ? "${local.eks_name}-${p.name}"
        : format(
          "%s-%s-%s",
          replace(substr(local.eks_name, 0, local.eks_node_group_name_max - 9 - length(p.name)), "/-+$/", ""),
          substr(sha256(local.eks_name), 0, 7),
          p.name,
        )
      )
      instance_types = [p.instance_type]
      ami_type       = local.eks_extra_ami_types[p.name]
      capacity_type  = p.capacity_type == "spot" ? "SPOT" : "ON_DEMAND"
      min_size       = p.min_size
      max_size       = p.max_size
      desired_size   = p.desired_size == null ? p.min_size : p.desired_size
      labels         = local.nodepool_contract_render[p.name].labels
      taints = {
        for t in local.nodepool_contract_render[p.name].taints : "${t.key}:${t.effect}" => {
          key    = t.key
          value  = t.value == "" ? null : t.value
          effect = local.eks_taint_effects[t.effect]
        }
      }
    }
  }
}
