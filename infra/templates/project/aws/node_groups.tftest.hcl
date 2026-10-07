# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# node_labels, node_taints and extra_node_pools on EKS (#5534): what the AWS template BUILDS from the
# node-pool contract's render. nodepool_contract.tftest.hcl proves the contract's rules and render on
# this template; this file proves the node groups:
#
#   · defaults: one node group, eks_workers, built from exactly the input it had before #5534;
#   · each extra pool is one more managed node group, with the render's labels and taints in EKS
#     spelling, its capacity type, sizes and the AMI type for its architecture;
#   · ISOLATION PARITY (#1012): every group has IMDSv2 required with hop limit 1, eks_workers'
#     subnets, and no per-group override of the root volume or the IAM policies. With hop limit 2,
#     any pod on a pool's nodes can take the node IAM role;
#   · AWS's own refusals: an instance type whose architecture is not the pool's.
#
# The mocks and file-level values are nodepool_contract.tftest.hcl's.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_partition" {
    defaults = {
      partition  = "aws"
      dns_suffix = "amazonaws.com"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "270587882865"
      arn        = "arn:aws:iam::270587882865:role/e2e"
      user_id    = "AROAEXAMPLE:e2e"
    }
  }
  mock_data "aws_iam_session_context" {
    defaults = {
      issuer_arn  = "arn:aws:iam::270587882865:role/e2e"
      issuer_id   = "AROAEXAMPLE"
      issuer_name = "e2e"
    }
  }
  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::270587882865:policy/mock"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::270587882865:role/mock"
    }
  }
  mock_resource "aws_eks_cluster" {
    defaults = {
      arn                   = "arn:aws:eks:us-east-1:270587882865:cluster/mock"
      certificate_authority = [{ data = "bW9jaw==" }]
      identity              = [{ oidc = [{ issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/MOCK" }] }]
    }
  }
  mock_resource "aws_launch_template" {
    defaults = {
      id = "lt-0123456789abcdef0"
    }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:us-east-1:270587882865:mock-karpenter"
    }
  }
  mock_data "aws_eks_addon_version" {
    defaults = {
      version = "v1.0.0-eksbuild.1"
    }
  }
}

mock_provider "aws" {
  alias = "virginia"
}

mock_provider "random" {}

variables {
  aws_account_id = "270587882865"
  region         = "us-east-1"
  vpc_cidr       = "10.0.0.0/16"
  environment    = "production"
  project_name   = "alethia-nl"

  # A cluster, so module.eks exists and every case plans the node groups it builds.
  provision_eks    = true
  enable_karpenter = true

  provision_ecr          = false
  create_rds             = false
  rds_iam_irsa           = false
  rds_iam_auth_enabled   = false
  registry_pull_provider = "native"

  sqs_queues                       = {}
  sns_topics                       = {}
  create_elasticache_redis         = false
  redis_cluster_size               = 1
  redis_cluster_mode_enabled       = false
  redis_instance_type              = "cache.t3.micro"
  redis_engine_version             = "7.1"
  redis_family                     = "redis7"
  redis_allowed_cidr_blocks        = []
  redis_allowed_security_group_ids = []
  redis_cloudwatch_logs_enabled    = false
  custom_secrets                   = []
  ddb_table_configuration          = []
  ddb_global_table_configuration   = []
  waf_logging_enabled              = false
  waf_log_retention_days           = 14
  waf_sampled_requests_enabled     = false
  waf_webacl_cloudwatch_enabled    = false
}

# Nothing set: eks_workers is the one node group, and its input is the one it had on origin/dev
# before #5534 (eks.tf), attribute for attribute. `labels` is null, which the upstream module reads
# exactly as it read the omitted attribute (try(each.value.labels, …, null)).
run "defaults_build_only_eks_workers_unchanged" {
  command = plan

  assert {
    condition     = keys(module.eks[0].managed_node_groups) == ["eks_workers"]
    error_message = "With no extra_node_pools, eks_workers must be the only managed node group."
  }

  assert {
    condition = jsonencode(module.eks[0].managed_node_groups.eks_workers) == jsonencode({
      iam_role_use_name_prefix = false
      name                     = "eks-ue1-production-alethia-nl-ng"
      min_size                 = 2
      max_size                 = 5
      desired_size             = 2
      ebs_optimized            = true
      metadata_options = {
        http_endpoint               = "enabled"
        http_tokens                 = "required"
        http_put_response_hop_limit = 1
        instance_metadata_tags      = "disabled"
      }
      subnet_ids            = module.common_vpc[0].private_subnets
      capacity_type         = "ON_DEMAND"
      create_security_group = true
      security_group_name   = "eks-ue1-production-alethia-nl-ng-sg"
      labels                = null
    })
    error_message = "eks_workers' input changed with every new variable at its default; a cluster that sets nothing must plan the node group it had before #5534."
  }

  assert {
    condition     = module.eks[0].managed_node_group_render.eks_workers.labels == null && length(module.eks[0].managed_node_group_render.eks_workers.taints) == 0
    error_message = "The planned eks_workers node group must carry no labels and no taints by default."
  }
}

# node_labels reach eks_workers' planned node group; node_taints do not (they would strand the
# platform's add-ons, which tolerate none of the user's taints).
run "node_labels_reach_eks_workers_and_node_taints_do_not" {
  command = plan

  variables {
    node_labels = { team = "payments" }
    node_taints = [{ key = "dedicated", value = "batch", effect = "NoSchedule" }]
  }

  assert {
    condition     = module.eks[0].managed_node_group_render.eks_workers.labels == tomap({ team = "payments" })
    error_message = "node_labels must reach the planned eks_workers node group."
  }

  assert {
    condition     = length(module.eks[0].managed_node_group_render.eks_workers.taints) == 0
    error_message = "node_taints must not reach eks_workers."
  }
}

# Two pools: an arm64 Spot batch pool and an amd64 GPU pool. Each is one more node group, built from
# the contract's render in EKS spelling.
run "two_pools_one_arm64_spot" {
  command = plan

  variables {
    node_labels = { team = "payments" }
    node_taints = [{ key = "dedicated", value = "batch", effect = "NoSchedule" }]
    extra_node_pools = [
      {
        name          = "batch"
        instance_type = "m7g.large"
        min_size      = 0
        max_size      = 10
        arch          = "arm64"
        capacity_type = "spot"
        labels        = { workload = "batch" }
        taints        = [{ key = "example.com/batch", effect = "PreferNoSchedule" }]
      },
      {
        name          = "gpu"
        instance_type = "g5.xlarge"
        min_size      = 1
        max_size      = 2
        desired_size  = 2
        taints        = [{ key = "gpu", value = "true", effect = "NoExecute" }]
      },
    ]
  }

  assert {
    condition     = toset(keys(module.eks[0].managed_node_groups)) == toset(["eks_workers", "batch", "gpu"])
    error_message = "Each extra_node_pools entry must become exactly one more managed node group."
  }

  assert {
    condition = (
      module.eks[0].managed_node_groups.batch.name == "eks-ue1-production-alethia-nl-batch" &&
      module.eks[0].managed_node_groups.batch.instance_types == tolist(["m7g.large"]) &&
      module.eks[0].managed_node_groups.batch.capacity_type == "SPOT" &&
      module.eks[0].managed_node_groups.batch.ami_type == "BOTTLEROCKET_ARM_64" &&
      module.eks[0].managed_node_groups.batch.min_size == 0 &&
      module.eks[0].managed_node_groups.batch.max_size == 10 &&
      module.eks[0].managed_node_groups.batch.desired_size == 0
    )
    error_message = "The arm64 Spot pool must be a SPOT group of m7g.large on the arm64 twin of eks_ami_type, with desired_size defaulting to min_size."
  }

  assert {
    condition = (
      module.eks[0].managed_node_groups.gpu.capacity_type == "ON_DEMAND" &&
      module.eks[0].managed_node_groups.gpu.ami_type == "BOTTLEROCKET_x86_64_NVIDIA" &&
      module.eks[0].managed_node_groups.gpu.desired_size == 2
    )
    error_message = "The GPU pool must be ON_DEMAND on the NVIDIA variant of eks_ami_type, with its own desired_size."
  }

  # The PLANNED node groups (aws_eks_node_group.labels / .taint), not only the module input.
  assert {
    condition = module.eks[0].managed_node_group_render.batch.labels == tomap({
      team              = "payments"
      workload          = "batch"
      "alethia.io/pool" = "batch"
    })
    error_message = "The batch node group must carry node_labels, its own labels and alethia.io/pool=batch."
  }

  assert {
    condition = toset(module.eks[0].managed_node_group_render.batch.taints) == toset([
      { key = "dedicated", value = "batch", effect = "NO_SCHEDULE" },
      { key = "example.com/batch", value = null, effect = "PREFER_NO_SCHEDULE" },
      { key = "alethia.io/arch", value = "arm64", effect = "NO_SCHEDULE" },
    ])
    error_message = "The batch node group must carry node_taints, its own taint and the platform arm64 taint, with EKS effect spelling and a null value where none was set."
  }

  assert {
    condition = toset(module.eks[0].managed_node_group_render.gpu.taints) == toset([
      { key = "dedicated", value = "batch", effect = "NO_SCHEDULE" },
      { key = "gpu", value = "true", effect = "NO_EXECUTE" },
    ])
    error_message = "The amd64 gpu node group must carry node_taints and its own taint, and no arm64 taint."
  }
}

# ISOLATION PARITY (#1012, the issue's item 4). Every extra group carries eks_workers' isolation
# controls. The upstream module defaults a group that omits metadata_options to hop limit 2, which
# lets any pod on the node assume the node IAM role: this run fails if any group is not at 1.
run "every_extra_group_keeps_the_isolation_of_eks_workers" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batch", instance_type = "m7g.large", min_size = 0, max_size = 4, arch = "arm64", capacity_type = "spot" },
      { name = "web", instance_type = "m7i.large", min_size = 1, max_size = 3 },
      { name = "gpu", instance_type = "g5.xlarge", min_size = 0, max_size = 1 },
    ]
  }

  assert {
    condition = alltrue([for k, g in module.eks[0].managed_node_groups :
      g.metadata_options.http_put_response_hop_limit == 1 &&
      g.metadata_options.http_tokens == "required" &&
      g.metadata_options.http_endpoint == "enabled"
    ])
    error_message = "Every managed node group must require IMDSv2 with hop limit 1; at 2, any pod on the node can take the node IAM role (#1012)."
  }

  assert {
    condition = alltrue([for k, g in module.eks[0].managed_node_groups :
      g.subnet_ids == module.eks[0].managed_node_groups.eks_workers.subnet_ids &&
      g.ebs_optimized == true &&
      g.iam_role_use_name_prefix == module.eks[0].managed_node_groups.eks_workers.iam_role_use_name_prefix
    ])
    error_message = "Every managed node group must use eks_workers' subnets, be EBS-optimized and name its IAM role the way eks_workers does."
  }

  # The encrypted root volume and the IAM policy attachments come from eks_managed_node_group_defaults
  # (modules/eks/eks.tf). A group that set its own would replace them.
  assert {
    condition = alltrue([for k, g in module.eks[0].managed_node_groups :
      !contains(keys(g), "block_device_mappings") && !contains(keys(g), "iam_role_additional_policies") &&
      !contains(keys(g), "iam_role_attach_cni_policy") && !contains(keys(g), "create_iam_role") &&
      !contains(keys(g), "vpc_security_group_ids") && !contains(keys(g), "disk_size")
    ])
    error_message = "No managed node group may override the encrypted root volume, the IAM policies or the node security group that eks_managed_node_group_defaults and the module give eks_workers."
  }
}

# An AL2023 cluster gets AL2023 for its arm64 pools, on the matching architecture.
run "an_al2023_cluster_gets_the_al2023_arm64_ami" {
  command = plan

  variables {
    eks_ami_type = "AL2023_x86_64_STANDARD"
    extra_node_pools = [
      { name = "batch", instance_type = "c7g.xlarge", min_size = 0, max_size = 4, arch = "arm64" },
      { name = "web", instance_type = "m7i.large", min_size = 1, max_size = 3 },
      { name = "gpu", instance_type = "g6.xlarge", min_size = 0, max_size = 1 },
    ]
  }

  assert {
    condition = (
      module.eks[0].managed_node_groups.batch.ami_type == "AL2023_ARM_64_STANDARD" &&
      module.eks[0].managed_node_groups.web.ami_type == "AL2023_x86_64_STANDARD" &&
      module.eks[0].managed_node_groups.gpu.ami_type == "AL2023_x86_64_NVIDIA"
    )
    error_message = "An AL2023 cluster must give an arm64 pool AL2023_ARM_64_STANDARD, an amd64 pool eks_ami_type and a GPU pool AL2023_x86_64_NVIDIA."
  }
}

# A node group name prefix may carry 36 characters before EKS's suffix. A long cluster name and a
# 12-character pool name are shortened with a digest of the cluster name, keeping the pool name.
run "a_long_node_group_name_is_shortened" {
  command = plan

  variables {
    extra_node_pools = [
      { name = "batchtwelve1", instance_type = "m7i.large", min_size = 0, max_size = 1 },
    ]
  }

  assert {
    condition = (
      length(module.eks[0].managed_node_groups.batchtwelve1.name) <= 36 &&
      endswith(module.eks[0].managed_node_groups.batchtwelve1.name, "-batchtwelve1") &&
      module.eks[0].managed_node_groups.batchtwelve1.name == module.eks[0].managed_node_groups.batchtwelve1.launch_template_name
    )
    error_message = "A node group name must fit 36 characters, end in its pool name, and name its launch template."
  }
}

# AWS's own rule: an arm64 pool needs a Graviton instance type, and an amd64 pool an x86 one.
run "refuses_an_arm64_pool_on_an_x86_instance_type" {
  command = plan

  variables {
    extra_node_pools = [{ name = "batch", instance_type = "m7i.large", min_size = 0, max_size = 1, arch = "arm64" }]
  }

  expect_failures = [var.extra_node_pools]
}

run "refuses_an_amd64_pool_on_a_graviton_instance_type" {
  command = plan

  variables {
    extra_node_pools = [{ name = "batch", instance_type = "m7g.large", min_size = 0, max_size = 1 }]
  }

  expect_failures = [var.extra_node_pools]
}

run "refuses_an_instance_type_that_is_not_family_dot_size" {
  command = plan

  variables {
    extra_node_pools = [{ name = "batch", instance_type = "Standard_D4s_v5", min_size = 0, max_size = 1 }]
  }

  expect_failures = [var.extra_node_pools]
}

# A FIPS cluster keeps FIPS on every pool: an arm64 pool gets the FIPS arm64 AMI, never the non-FIPS
# one.
run "a_fips_cluster_gets_the_fips_arm64_ami" {
  command = plan

  variables {
    eks_ami_type = "BOTTLEROCKET_x86_64_FIPS"
    extra_node_pools = [
      { name = "batch", instance_type = "m7g.large", min_size = 0, max_size = 4, arch = "arm64" },
      { name = "web", instance_type = "m7i.large", min_size = 1, max_size = 3 },
    ]
  }

  assert {
    condition = (
      module.eks[0].managed_node_groups.batch.ami_type == "BOTTLEROCKET_ARM_64_FIPS" &&
      module.eks[0].managed_node_groups.web.ami_type == "BOTTLEROCKET_x86_64_FIPS"
    )
    error_message = "A FIPS cluster must give every extra pool a FIPS AMI of its architecture."
  }
}

# Graviton 1 (a1) is an arm64 instance type.
run "an_a1_instance_type_is_arm64" {
  command = plan

  variables {
    extra_node_pools = [{ name = "edge", instance_type = "a1.large", min_size = 0, max_size = 2, arch = "arm64" }]
  }

  assert {
    condition     = module.eks[0].managed_node_groups.edge.ami_type == "BOTTLEROCKET_ARM_64"
    error_message = "An a1 pool is arm64 and takes the arm64 AMI."
  }
}

# No FIPS Bottlerocket AMI carries the NVIDIA driver: refused rather than silently non-FIPS.
run "refuses_a_gpu_pool_on_a_fips_cluster" {
  command = plan

  variables {
    eks_ami_type     = "BOTTLEROCKET_x86_64_FIPS"
    extra_node_pools = [{ name = "gpu", instance_type = "g5.xlarge", min_size = 0, max_size = 1 }]
  }

  expect_failures = [var.extra_node_pools]
}

# An eks_ami_type with no x86 family to derive from (here an arm64 default group) is refused for
# extra pools, rather than leaving a pool on an AMI that does not match it.
run "refuses_extra_pools_on_a_non_x86_eks_ami_type" {
  command = plan

  variables {
    eks_ami_type     = "BOTTLEROCKET_ARM_64"
    extra_node_pools = [{ name = "web", instance_type = "m7i.large", min_size = 0, max_size = 1 }]
  }

  expect_failures = [var.extra_node_pools]
}

# The same eks_ami_type with no extra pools is not this file's business: it plans as before.
run "a_non_x86_eks_ami_type_without_extra_pools_still_plans" {
  command = plan

  variables {
    eks_ami_type = "BOTTLEROCKET_ARM_64"
  }

  assert {
    condition     = keys(module.eks[0].managed_node_groups) == ["eks_workers"]
    error_message = "Without extra pools, eks_ami_type is unconstrained by #5534."
  }
}
