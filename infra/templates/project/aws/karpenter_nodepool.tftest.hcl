# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The Karpenter NodePool knobs (#5527): every value a user sets in the Cluster component's
# provider_config reaches the `karpenter_nodepool` output the runner renders the NodePool from, every
# default is the literal the runner hard-coded before, and every value Karpenter or Kubernetes would
# refuse is refused HERE, at plan, with a message naming what is allowed.
#
# The runner re-checks the same rules (packages/core/provisioner/karpenter_nodepool_test.go), because
# it applies the manifest with cluster-admin rights and a validation that lives only in this template
# is bypassed by a hand-edited state.
#
# The mocks are the ones checks_cluster_optional.tftest.hcl documents; the cluster has to plan for
# module.karpenter to exist, and the output is null without it.

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

  # THE shape under test: a cluster with Karpenter on, so module.karpenter exists and the output
  # carries a value.
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

################################################################################
# 1. Defaults — exactly the literals the runner hard-coded before #5527
################################################################################

run "defaults_are_the_pre_5527_literals" {
  command = plan

  assert {
    condition = jsonencode(output.karpenter_nodepool) == jsonencode({
      architectures       = ["amd64"]
      capacity_types      = ["on-demand"]
      cpu_limit           = 100
      instance_categories = ["t", "m"]
      instance_families   = []
      labels              = {}
      taints              = []
    })
    error_message = "A cluster that sets no Karpenter knob must hand the runner today's literals; got ${jsonencode(output.karpenter_nodepool)}."
  }
}

run "no_karpenter_means_no_nodepool_output" {
  command = plan

  variables {
    enable_karpenter = false
  }

  assert {
    condition     = output.karpenter_nodepool == null
    error_message = "With Karpenter off there is no NodePool to render; the output must be null."
  }
}

################################################################################
# 2. Every knob reaches the output
################################################################################

run "every_knob_reaches_the_runner" {
  command = plan

  variables {
    karpenter_capacity_types      = ["spot", "on-demand"]
    karpenter_architectures       = ["arm64"]
    karpenter_instance_categories = ["c", "m"]
    karpenter_instance_families   = ["c7g", "m7g"]
    karpenter_cpu_limit           = 400
    karpenter_node_labels         = { "workload" = "batch", "node-restriction.kubernetes.io/pool" = "batch" }
    karpenter_node_taints = [
      { key = "dedicated", value = "batch", effect = "NoSchedule" },
      { key = "example.com/gpu", effect = "NoExecute" },
    ]
  }

  assert {
    condition = jsonencode(output.karpenter_nodepool) == jsonencode({
      architectures       = ["arm64"]
      capacity_types      = ["spot", "on-demand"]
      cpu_limit           = 400
      instance_categories = ["c", "m"]
      instance_families   = ["c7g", "m7g"]
      labels              = { "node-restriction.kubernetes.io/pool" = "batch", "workload" = "batch" }
      taints = [
        { effect = "NoSchedule", key = "dedicated", value = "batch" },
        { effect = "NoExecute", key = "example.com/gpu", value = null },
      ]
    })
    error_message = "Every Karpenter knob must reach the karpenter_nodepool output unchanged; got ${jsonencode(output.karpenter_nodepool)}."
  }
}

# Families with categories cleared: the family requirement alone selects the instances.
run "families_without_categories_plan" {
  command = plan

  variables {
    karpenter_instance_categories = []
    karpenter_instance_families   = ["c7g"]
  }

  assert {
    condition     = jsonencode(output.karpenter_nodepool.instance_families) == jsonencode(["c7g"]) && length(output.karpenter_nodepool.instance_categories) == 0
    error_message = "Clearing the categories must let a family stand on its own."
  }
}

################################################################################
# 3. Refusals — each value Karpenter or Kubernetes would reject fails the plan
################################################################################

run "refuses_an_unknown_capacity_type" {
  command = plan
  variables {
    karpenter_capacity_types = ["reserved"]
  }
  expect_failures = [var.karpenter_capacity_types]
}

run "refuses_an_empty_capacity_type_list" {
  command = plan
  variables {
    karpenter_capacity_types = []
  }
  expect_failures = [var.karpenter_capacity_types]
}

run "refuses_an_unknown_architecture" {
  command = plan
  variables {
    karpenter_architectures = ["x86_64"]
  }
  expect_failures = [var.karpenter_architectures]
}

run "refuses_a_malformed_instance_category" {
  command = plan
  variables {
    karpenter_instance_categories = ["C"]
  }
  expect_failures = [var.karpenter_instance_categories]
}

run "refuses_a_malformed_instance_family" {
  command = plan
  variables {
    karpenter_instance_families = ["c7g.large"]
  }
  expect_failures = [var.karpenter_instance_families]
}

run "refuses_a_cpu_limit_above_the_ceiling" {
  command = plan
  variables {
    karpenter_cpu_limit = 10001
  }
  expect_failures = [var.karpenter_cpu_limit]
}

run "refuses_a_zero_cpu_limit" {
  command = plan
  variables {
    karpenter_cpu_limit = 0
  }
  expect_failures = [var.karpenter_cpu_limit]
}

run "refuses_a_fractional_cpu_limit" {
  command = plan
  variables {
    karpenter_cpu_limit = 1.5
  }
  expect_failures = [var.karpenter_cpu_limit]
}

run "refuses_an_unknown_taint_effect" {
  command = plan
  variables {
    karpenter_node_taints = [{ key = "dedicated", value = "batch", effect = "NoScheduleEver" }]
  }
  expect_failures = [var.karpenter_node_taints]
}

run "refuses_a_label_in_the_kubernetes_io_domain" {
  command = plan
  variables {
    karpenter_node_labels = { "kubernetes.io/arch" = "arm64" }
  }
  expect_failures = [var.karpenter_node_labels]
}

# node-role.kubernetes.io is NOT an exception: Karpenter's NodePool CRD admits only the
# node.kubernetes.io and node-restriction.kubernetes.io subdomains of kubernetes.io, so a
# node-role label would pass here and be refused by the API server at apply.
run "refuses_a_label_in_the_node_role_domain" {
  command = plan
  variables {
    karpenter_node_labels = { "node-role.kubernetes.io/batch" = "" }
  }
  expect_failures = [var.karpenter_node_labels]
}

run "refuses_a_label_in_a_k8s_io_subdomain" {
  command = plan
  variables {
    karpenter_node_labels = { "kops.k8s.io/instancegroup" = "x" }
  }
  expect_failures = [var.karpenter_node_labels]
}

run "refuses_a_label_in_the_karpenter_sh_domain" {
  command = plan
  variables {
    karpenter_node_labels = { "karpenter.sh/nodepool" = "other" }
  }
  expect_failures = [var.karpenter_node_labels]
}

run "refuses_a_label_in_the_karpenter_k8s_aws_domain" {
  command = plan
  variables {
    karpenter_node_labels = { "karpenter.k8s.aws/instance-family" = "c7g" }
  }
  expect_failures = [var.karpenter_node_labels]
}

# No dot boundary, matching Karpenter's NodePool CRD (`endsWith("kubernetes.io")` on the prefix):
# a prefix that merely ends in a reserved domain is refused at apply, so it is refused here.
run "refuses_a_label_in_a_domain_merely_ending_in_kubernetes_io" {
  command = plan
  variables {
    karpenter_node_labels = { "examplekubernetes.io/x" = "y" }
  }
  expect_failures = [var.karpenter_node_labels]
}

run "refuses_a_label_prefix_with_a_dns_label_over_63" {
  command = plan
  variables {
    karpenter_node_labels = { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com/x" = "y" }
  }
  expect_failures = [var.karpenter_node_labels]
}

run "refuses_a_malformed_label_value" {
  command = plan
  variables {
    karpenter_node_labels = { "workload" = "batch: true" }
  }
  expect_failures = [var.karpenter_node_labels]
}

run "refuses_a_taint_key_in_a_reserved_domain" {
  command = plan
  variables {
    karpenter_node_taints = [{ key = "node.kubernetes.io/unschedulable", effect = "NoSchedule" }]
  }
  expect_failures = [var.karpenter_node_taints]
}

run "refuses_a_malformed_taint_key" {
  command = plan
  variables {
    karpenter_node_taints = [{ key = "bad key", effect = "NoSchedule" }]
  }
  expect_failures = [var.karpenter_node_taints]
}

# The default categories are ["t", "m"]; a c7g family under them leaves Karpenter no instance type.
run "refuses_a_family_outside_every_category" {
  command = plan
  variables {
    karpenter_instance_families = ["c7g"]
  }
  expect_failures = [output.karpenter_nodepool]
}
