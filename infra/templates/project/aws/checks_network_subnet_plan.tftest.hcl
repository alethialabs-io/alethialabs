# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the VPC subnet plan gives the AWS VPC CNI enough addresses to hand every pod an IP, and
# that widening the private subnets did not silently move anything else on top of them.
#
# The defect (#1919): the private subnets were `cidrsubnet(vpc, 10, {0,4,8})` — a /26, 59 usable —
# while the DATABASE subnets were a /24. Under the VPC CNI every pod takes a real address out of the
# node's subnet, and one m5a.4xlarge (the default of var.eks_instance_types) draws up to
# 8 ENIs × 30 IPv4 = 240 of them. The aws nightly died at
#   `plugin type="aws-cni" … failed (add): add cmd: failed to assign an IP address to container`
# after ArgoCD's pods filled 10.0.1.10 … 10.0.1.56 of 10.0.1.0/26 on a SINGLE t3.large.
#
# Two properties are pinned here, and they pull in opposite directions — which is the whole reason
# the file exists:
#   1. the private subnets are WIDE enough (≥ /20 on a /16, i.e. 1/16 of the VPC);
#   2. nothing OVERLAPS, and the public and database subnets are byte-identical to what they were.
# Widening without (2) would put the private subnets on top of the public ones, which AWS accepts
# subnet-by-subnet and which then shows up as unroutable addresses long after apply.
#
# The whole derivation is a pure function of var.vpc_cidr, hoisted to root `locals` in networking.tf
# so `assert` can read it — a module's arguments are not reachable from a test, and
# `modules/**/*.tftest.hcl` is silently never executed, so this file lives at the ROOT.
#
# Providers are mocked and every provisionable component but the VPC is off, so this needs no
# credentials and runs on any PR. The aliased `virginia` provider is mocked separately on purpose:
# mock_provider mocks one provider CONFIGURATION, not one provider type, so without it the second
# one still authenticates — against whatever ambient AWS credentials the machine happens to carry,
# which is how a test like this turns into a false green.

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
  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:us-east-1:270587882865:key/1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809"
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

  # The subnet plan is decided from vpc_cidr alone, before any resource exists. Everything that
  # would need a real API is off; provision_vpc stays TRUE because it is the branch under test.
  provision_vpc            = true
  provision_eks            = false
  provision_ecr            = false
  create_rds               = false
  create_elasticache_redis = false
  rds_iam_irsa             = false
  rds_iam_auth_enabled     = false
  enable_karpenter         = false
  registry_pull_provider   = "native"

  # Declared with no default, so a plan cannot start without them. Inert here.
  sqs_queues                       = {}
  sns_topics                       = {}
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
# 1. The pod address budget
#
# The assertion the old derivation fails. A /26 is 64 addresses; the width assertion below demands
# a /20 or wider, and the capacity assertion demands room for more than one default node.
################################################################################

# Each private subnet must be at least a /20 on a /16 — 1/16 of the VPC. Written as "prefix ≤ 20"
# because a smaller prefix number is a WIDER network.
run "every_private_subnet_is_at_least_a_slash_20" {
  command = plan

  assert {
    condition = alltrue([
      for c in local.vpc_private_subnet_cidrs : tonumber(split("/", c)[1]) <= 20
    ])
    error_message = "Private subnets must be /20 or wider for the VPC CNI; got ${jsonencode(local.vpc_private_subnet_cidrs)}. A /26 holds 59 usable addresses and one m5a.4xlarge draws up to 240."
  }
}

# The budget stated as addresses rather than as a prefix, so the reason survives a future rewrite of
# the derivation. `var.eks_instance_types` defaults to ["m5a.4xlarge"] = 8 ENIs × 30 IPv4 = 240
# addresses per node, and AWS reserves 5 addresses in every subnet. Two nodes per AZ is the floor a
# cluster that can roll a node has to clear; the shipped /20 clears it seventeen times over.
run "a_private_subnet_holds_more_than_one_default_node" {
  command = plan

  assert {
    condition = alltrue([
      for c in local.vpc_private_subnet_cidrs : (pow(2, 32 - tonumber(split("/", c)[1])) - 5) >= 2 * 240
    ])
    error_message = "Each private subnet must hold at least two m5a.4xlarge nodes' worth of pod addresses (2 × 8 ENIs × 30 IPv4 = 480, plus AWS's 5 reserved); got ${jsonencode(local.vpc_private_subnet_cidrs)}."
  }
}

# The concrete map on the documented /16, pinned literally. Recomputing cidrsubnet inside the
# assertion would pass against a broken derivation because both sides would drift together.
run "the_plan_on_a_slash_16_is_the_documented_map" {
  command = plan

  assert {
    condition     = local.vpc_private_subnet_cidrs == ["10.0.32.0/20", "10.0.48.0/20", "10.0.64.0/20"]
    error_message = "Private subnets moved: got ${jsonencode(local.vpc_private_subnet_cidrs)}."
  }
}

################################################################################
# 2. Nothing else moved
#
# Widening the private subnets is a REPLACEMENT. Renumbering the public subnets would additionally
# replace the NAT gateways (new Elastic IPs — every customer egress allow-list breaks), and
# renumbering the database subnets would replace the RDS subnet group. Both must stay byte-identical
# to what shipped, and that is a stronger statement than "they do not overlap".
################################################################################

run "the_public_subnets_are_unchanged" {
  command = plan

  assert {
    condition     = local.vpc_public_subnet_cidrs == ["10.0.3.0/26", "10.0.4.0/26", "10.0.5.0/26"]
    error_message = "Public subnets must keep their shipped CIDRs — changing one replaces the NAT gateway and its Elastic IP. Got ${jsonencode(local.vpc_public_subnet_cidrs)}."
  }
}

run "the_database_subnets_are_unchanged" {
  command = plan

  assert {
    condition     = local.vpc_database_subnet_cidrs == ["10.0.24.0/24", "10.0.25.0/24", "10.0.26.0/24"]
    error_message = "Database subnets must keep their shipped CIDRs — changing one replaces the RDS subnet group. Got ${jsonencode(local.vpc_database_subnet_cidrs)}."
  }
}

################################################################################
# 3. Non-overlap, proven twice
################################################################################

# Once in address arithmetic on a real /16: all nine subnets are turned into half-open
# [start, start+size) intervals of offsets inside 10.0.0.0/16 and compared pairwise. `for R in [ … ]`
# is only there to give the list a name the comparison can index — HCL has no let-binding.
#
# This is the assertion that catches the naive widening: `cidrsubnet(vpc, 4, 0)` would put
# private[0] at 10.0.0.0/20, swallowing all three public subnets at 10.0.3-5.
run "no_two_subnets_overlap_on_a_slash_16" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for R in [[
        for c in concat(local.vpc_private_subnet_cidrs, local.vpc_public_subnet_cidrs, local.vpc_database_subnet_cidrs) : {
          start = tonumber(split(".", split("/", c)[0])[2]) * 256 + tonumber(split(".", split("/", c)[0])[3])
          size  = pow(2, 32 - tonumber(split("/", c)[1]))
        }
        ]] : [
        for p in setproduct(range(length(R)), range(length(R))) :
        p[0] >= p[1] ? true : (
          R[p[0]].start + R[p[0]].size <= R[p[1]].start ||
          R[p[1]].start + R[p[1]].size <= R[p[0]].start
        )
      ]
    ]))
    error_message = "Subnets overlap. private=${jsonencode(local.vpc_private_subnet_cidrs)} public=${jsonencode(local.vpc_public_subnet_cidrs)} database=${jsonencode(local.vpc_database_subnet_cidrs)}."
  }
}

# And once on the VPC-size-independent form. local.vpc_subnet_plan_spans is built from the
# (newbits, netnum) pairs alone, in units of 1/1024 of the VPC, so disjointness there holds for every
# legal vpc_cidr rather than only for the /16 above. check.vpc_subnet_plan_disjoint asserts the same
# thing at plan time, but a `check` only WARNs — this is the copy that fails a build.
run "the_plan_is_disjoint_at_every_vpc_size" {
  command = plan

  assert {
    condition = alltrue([
      for p in setproduct(range(length(local.vpc_subnet_plan_spans)), range(length(local.vpc_subnet_plan_spans))) :
      p[0] >= p[1] ? true : (
        local.vpc_subnet_plan_spans[p[0]].end <= local.vpc_subnet_plan_spans[p[1]].start ||
        local.vpc_subnet_plan_spans[p[1]].end <= local.vpc_subnet_plan_spans[p[0]].start
      )
    ])
    error_message = "The subnet plan overlaps itself in 1024ths of the VPC: ${jsonencode(local.vpc_subnet_plan_spans)}."
  }
}

# The public subnets end at 21/1024 and the database subnets start at 96/1024, so the gap the private
# subnets were moved ABOVE is real; pinning the boundary numbers makes a future netnum edit that eats
# the gap fail here rather than in a customer's VPC.
run "the_private_block_sits_above_the_database_block" {
  command = plan

  assert {
    condition = (
      max([for s in local.vpc_subnet_plan_spans : s.end if startswith(s.name, "public")]...) == 21 &&
      max([for s in local.vpc_subnet_plan_spans : s.end if startswith(s.name, "database")]...) == 108 &&
      min([for s in local.vpc_subnet_plan_spans : s.start if startswith(s.name, "private")]...) == 128
    )
    error_message = "Expected public to end at 21/1024, database at 108/1024 and private to start at 128/1024; got ${jsonencode(local.vpc_subnet_plan_spans)}."
  }
}

################################################################################
# 4. A VPC CIDR too small to carve is REFUSED, not silently mangled
#
# vpc_cidr is a customer input with `default = ""` and, until now, only a "is it a CIDR" validation.
# The derivation is proportional, so on a narrow VPC it degrades instead of failing:
#   /19  → public /29  — computes fine, then AWS rejects it mid-apply ("minimum /28")
#   /24  → public /34  — cidrsubnet raises a hard function error naming no input at all
# Both are worse than a refusal, so provision_vpc + a too-small vpc_cidr now fails at PLAN time with
# a message that says what to do.
#
# Refusing rather than adapting is deliberate: adapting would mean renumbering the public and
# database subnets per VPC size, which replaces NAT gateways and the RDS subnet group for customers
# who changed nothing.
################################################################################

run "a_slash_19_vpc_is_refused" {
  command = plan

  variables {
    vpc_cidr = "10.0.0.0/19"
  }

  expect_failures = [
    check.vpc_cidr_large_enough_to_carve,
    terraform_data.vpc_cidr_carvable_guard,
  ]
}

# The shape that today kills the plan inside cidrsubnet with an error naming no variable.
run "a_slash_24_vpc_is_refused" {
  command = plan

  variables {
    vpc_cidr = "10.0.0.0/24"
  }

  expect_failures = [
    check.vpc_cidr_large_enough_to_carve,
    terraform_data.vpc_cidr_carvable_guard,
  ]
}

# The acceptance half — without it the guard could be satisfied by refusing every VPC. /18 is the
# floor, and it is the floor because that is exactly where the public subnets hit AWS's /28 minimum.
# The private subnets are still a /22 there, 1019 usable, four default nodes.
run "a_slash_18_vpc_is_accepted_and_is_the_floor" {
  command = plan

  variables {
    vpc_cidr = "10.0.0.0/18"
  }

  assert {
    condition     = alltrue([for c in local.vpc_public_subnet_cidrs : tonumber(split("/", c)[1]) == 28])
    error_message = "At the /18 floor the public subnets must land exactly on AWS's /28 minimum; got ${jsonencode(local.vpc_public_subnet_cidrs)}."
  }

  assert {
    condition     = alltrue([for c in local.vpc_private_subnet_cidrs : tonumber(split("/", c)[1]) == 22])
    error_message = "At the /18 floor the private subnets must be a /22; got ${jsonencode(local.vpc_private_subnet_cidrs)}."
  }
}

# The guard must not catch BROWNFIELD. A customer adopting an existing VPC (provision_vpc = false)
# passes their real vpc_cidr — locals.tf feeds it to redis_allowed_cidr_blocks — and it may
# legitimately be a /24 that Alethia never has to carve. This is why the guard is a precondition
# reading provision_vpc and NOT a `validation` block on var.vpc_cidr, which cannot see it.
run "a_small_vpc_cidr_on_an_external_vpc_is_not_refused" {
  command = plan

  variables {
    provision_vpc          = false
    vpc_cidr               = "10.7.3.0/24"
    vpc_id                 = "vpc-0123456789abcdef0"
    vpc_private_subnet_ids = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
    vpc_public_subnet_ids  = ["subnet-0cccccccccccccccc", "subnet-0dddddddddddddddd"]
  }

  assert {
    condition     = !local.vpc_cidr_is_carvable
    error_message = "A /24 must be reported as un-carvable; the point is that nothing BLOCKS on it when provision_vpc is false."
  }
}
