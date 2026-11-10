# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Every IRSA role in irsa.tf trusts an exact, named list of ServiceAccounts (#6556).
#
# What this pins, and what it does not. The trust document itself is rendered by an
# `aws_iam_policy_document` inside the upstream iam-role-for-service-accounts-eks module, and under a
# mocked provider that data source returns whatever the mock says — so a plan cannot show the real
# trust JSON. The suite therefore pins the two things that DECIDE it:
#
#   1. the VALUE — `local.irsa_service_accounts`, the one map every role reads its subjects from, is
#      asserted equal to an exact literal, and no entry may contain `*` or `?` (the two IAM
#      `StringLike` wildcards);
#   2. the WIRING — irsa.tf is read as source, and every IRSA module in it must take its subjects
#      from that map and match with `StringEquals`. Without this half an inline
#      `namespace_service_accounts = [...]` would bypass the pinned map and pass (1) untouched.
#
# BOUNDARY, stated so nobody reads more into a green run: (2) reads irsa.tf only. The other IRSA
# roles in this template — registry-pull.tf, helm-repo-pull.tf, karpenter.tf's module inputs and
# modules/eks/irsa.tf — are not routed through the map. Run (3) still refuses a wildcard in any of
# their literal subject lists, but it reads source text, so a wildcard arriving through a variable
# or local in one of those files is not seen.

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
}

mock_provider "aws" {
  alias = "virginia"
}

mock_provider "random" {}

# The subject map does not depend on the cluster, so the cheapest shape that plans is enough: no
# cluster, nothing hanging off it. Same input contract as checks_cluster_optional.tftest.hcl.
variables {
  aws_account_id = "270587882865"
  region         = "us-east-1"
  vpc_cidr       = "10.0.0.0/16"
  environment    = "production"
  project_name   = "alethia-nl"

  provision_eks          = false
  provision_ecr          = false
  create_rds             = false
  rds_iam_irsa           = false
  rds_iam_auth_enabled   = false
  enable_karpenter       = false
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

# 1. The value. A literal, not derived from the locals it checks: a change to any subject has to be
#    made twice, here and in irsa.tf, and the second edit is where a reviewer sees it.
run "every_irsa_role_names_its_exact_service_accounts" {
  command = plan

  assert {
    condition = local.irsa_service_accounts == {
      rds_iam_auth         = ["default:alethia-app"]
      fluentbit_cloudwatch = ["fluent-bit:fluent-bit"]
      karpenter            = ["karpenter:karpenter"]
      ecr_build            = ["alethia-build:kaniko-builder"]
    }
    error_message = "irsa.tf's local.irsa_service_accounts changed. Each subject is the ServiceAccount that carries the role's eks.amazonaws.com/role-arn; update this literal only together with the consumer named in irsa.tf's header."
  }

  assert {
    condition = alltrue(flatten([
      for role, subjects in local.irsa_service_accounts : [
        for s in subjects : length(regexall("[*?]", s)) == 0 && length(regexall("^[a-z0-9]([-a-z0-9]*[a-z0-9])?:[a-z0-9]([-.a-z0-9]*[a-z0-9])?$", s)) == 1
      ]
    ]))
    error_message = "Every IRSA subject must be one literal namespace:serviceaccount — no `*` or `?` pattern."
  }

  assert {
    condition     = alltrue([for role, subjects in local.irsa_service_accounts : length(subjects) > 0])
    error_message = "A role with no subjects trusts nothing; remove the role instead."
  }
}

# 2. The wiring. Every IRSA module in irsa.tf reads its subjects from the pinned map, one map entry
#    per module, and matches with StringEquals.
run "every_irsa_module_in_irsa_tf_reads_the_pinned_map" {
  command = plan

  assert {
    condition = (
      length(regexall("namespace_service_accounts\\s*=", file("${path.module}/irsa.tf"))) ==
      length(regexall("namespace_service_accounts\\s*=\\s*local\\.irsa_service_accounts\\.[a-z_]+\\s*\\n", file("${path.module}/irsa.tf")))
    )
    error_message = "An IRSA module in irsa.tf sets namespace_service_accounts from something other than local.irsa_service_accounts.<role>; route it through the pinned map."
  }

  assert {
    condition = (
      length(regexall("iam-role-for-service-accounts-eks", file("${path.module}/irsa.tf"))) ==
      length(local.irsa_service_accounts)
    )
    error_message = "irsa.tf's IRSA module count and local.irsa_service_accounts disagree: every role needs exactly one entry, and an entry with no role is stale."
  }

  assert {
    condition = (
      length(regexall("assume_role_condition_test\\s*=", file("${path.module}/irsa.tf"))) ==
      length(regexall("assume_role_condition_test\\s*=\\s*\"StringEquals\"", file("${path.module}/irsa.tf")))
    )
    error_message = "Every IRSA role in irsa.tf must match its subjects with StringEquals; StringLike turns a subject into a pattern."
  }
}

# 3. No literal wildcard subject anywhere in the template's IRSA inputs, including the roles outside
#    irsa.tf. Matches both `namespace_service_accounts` and karpenter's
#    `irsa_namespace_service_accounts`.
run "no_irsa_subject_list_in_the_template_is_a_pattern" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for f in concat(tolist(fileset(path.module, "*.tf")), tolist(fileset(path.module, "modules/*/*.tf"))) : [
        for list in regexall("namespace_service_accounts\\s*=\\s*\\[([^\\]]*)\\]", file("${path.module}/${f}")) :
        length(regexall("[*?]", list[0])) == 0
      ]
    ]))
    error_message = "An IRSA subject list in the AWS template contains `*` or `?`; name the exact namespace:serviceaccount instead."
  }

  # The scan above passes vacuously if its regex stops matching. Eight literal lists exist today
  # (registry-pull, helm-repo-pull, karpenter.tf, and five in modules/eks/irsa.tf); fewer means the
  # scan went blind, not that the template got cleaner.
  assert {
    condition = length(flatten([
      for f in concat(tolist(fileset(path.module, "*.tf")), tolist(fileset(path.module, "modules/*/*.tf"))) :
      regexall("namespace_service_accounts\\s*=\\s*\\[([^\\]]*)\\]", file("${path.module}/${f}"))
    ])) >= 8
    error_message = "The wildcard scan matched fewer than the eight literal IRSA subject lists the template holds; the scan, not the template, changed."
  }
}
