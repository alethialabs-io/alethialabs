# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the two guards added for #1753 actually REFUSE and actually PRODUCE what they claim.
#
# Both defects come from the same weekly full-bar run (30738253176), and both were invisible to
# `tofu validate`, which never evaluates a variable validation and never renders a local:
#
#   1. aws_account_id arrived EMPTY. It is interpolated into account-scoped ARNs across the whole
#      template, so the apply died hours in, at the RDS secret's KMS key, with an error that named
#      KMS and never the missing input:
#        InvalidArnException: An ARN in the specified key policy is invalid.
#      The emitted plan JSON carried "aws_account_id":{"value":""} while the credentials were fine.
#
#   2. The ECR lifecycle policy was created with EMPTY text, because create_lifecycle_policy
#      defaults to true and the document was never threaded to the upstream module:
#        InvalidParameterException: Invalid parameter at 'lifecyclePolicyText' failed to satisfy
#        constraint: 'Member must have length greater than or equal to 100'
#      Not an e2e-only bug — every tenant with provision_ecr + a native registry hit it.
#
# A guard nobody has seen fail is indistinguishable from no guard, so each is pinned from BOTH
# sides: the rejection AND the acceptance. Providers are mocked and every provisionable component
# is off, so this needs no credentials and runs on any PR.

mock_provider "aws" {
  # The ONLY mocked attribute this suite needs, and it is a mock of the system under test's own
  # input rather than of incidental scaffolding: the mock returns a generated string for every
  # unset attribute, and module.ecr feeds that string straight into
  # aws_ecr_repository_policy.this.policy, which the provider parses before any API call —
  #   Error: "policy" contains an invalid JSON: invalid character 'r' looking for beginning of value
  # Stubbing it with valid, minimal JSON keeps the plan walking to the lifecycle-policy assertions.
  #
  # Eight further mock blocks (aws_partition, aws_caller_identity, aws_iam_session_context,
  # aws_iam_policy, aws_iam_role, aws_eks_cluster, aws_launch_template, aws_eks_addon_version) used
  # to sit here. Every one of them existed to keep the upstream EKS module's plan walking, and none
  # is reachable now that this suite runs `provision_eks = false` — measured by leave-one-out: the
  # suite is green without all eight and red without this one. Mocks that no longer gate anything
  # are the kind of scaffolding that quietly turns into a false green.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

# main.tf declares a SECOND aws provider (alias `virginia`, for the WAF module). mock_provider
# mocks one provider CONFIGURATION, not one provider type, so without this the aliased one still
# tries to authenticate — "No valid credential sources found" — even with every WAF flag off.
# It defines no resources here, so it needs no mocked attributes.
mock_provider "aws" {
  alias = "virginia"
}

mock_provider "random" {}

variables {
  region       = "us-east-1"
  vpc_cidr     = "10.0.0.0/16"
  environment  = "production"
  project_name = "alethia-nl"

  # Neither property under test is cluster-scoped: aws_account_id is enforced by a variable
  # validation (graph-independent) and the ECR lifecycle document is a local. Since #1772 made
  # `provision_eks = false` plannable, this suite takes the smallest graph that can decide them —
  # which is what let eight mock blocks go, above. The cluster-ful shape is not lost: it is the
  # subject of checks_cluster_optional.tftest.hcl.
  #
  # The one thing this gives up, said out loud rather than left for a reviewer to find: the suite no
  # longer incidentally interpolates aws_account_id through the whole EKS/IRSA ARN graph. That was
  # never the assertion — the guard is a `validation` block on the variable, which runs before any
  # graph exists — but it did happen, and now it does not.
  provision_eks = false
  provision_ecr = false
  create_rds    = false

  # The template declares these with no default, so a plan cannot start without them. They are
  # inert here (every corresponding component is off) and exist only to satisfy the input contract.
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
# aws_account_id — the fail-closed guard
################################################################################

# The real account id from run 30738253176, in the shape that must be ACCEPTED. Without this half
# the guard could be satisfied by refusing everything, and a regex that rejected legal ids would go
# unnoticed until it blocked a real tenant.
run "a_twelve_digit_account_id_is_accepted" {
  command = plan

  variables {
    aws_account_id = "270587882865"
  }
}

# The exact value the full-bar nightly emitted. This is the assertion that distinguishes a real
# gate from the silent interpolation it replaces: empty must BLOCK the plan, not render
# `arn:aws:iam:::root` and fail mid-apply.
run "an_empty_account_id_blocks_the_plan" {
  command = plan

  variables {
    aws_account_id = ""
  }

  expect_failures = [var.aws_account_id]
}

# Malformed, not merely empty. A truncated or mistyped id produces the same invalid ARN, so the
# guard checks the SHAPE rather than just non-emptiness — 11 digits is the nearest miss.
run "a_malformed_account_id_blocks_the_plan" {
  command = plan

  variables {
    aws_account_id = "27058788286"
  }

  expect_failures = [var.aws_account_id]
}

################################################################################
# The ECR lifecycle policy document
################################################################################

# AWS's own constraint is the assertion: >= 100 characters. Asserting merely "not empty" would have
# passed for a `{}` document and still failed at apply, which is the failure mode being fixed.
run "the_default_lifecycle_policy_satisfies_the_aws_minimum" {
  command = plan

  variables {
    aws_account_id = "270587882865"
    provision_ecr  = true
    ecr_names_map  = { app = "app-images" }
  }

  assert {
    condition     = length(module.ecr.lifecycle_policy_document) >= 100
    error_message = "The ECR lifecycle policy must be >= 100 characters — AWS rejects anything shorter, which is exactly how run 30738253176 died. Got ${length(module.ecr.lifecycle_policy_document)}."
  }

  # Both rules must survive. A document that expired untagged images but kept every tagged image
  # ever pushed would satisfy the length bound above and still let the registry grow without limit.
  assert {
    condition     = can(regex("sinceImagePushed", module.ecr.lifecycle_policy_document)) && can(regex("imageCountMoreThan", module.ecr.lifecycle_policy_document))
    error_message = "The default policy must both expire untagged images and cap the tagged image count, got ${module.ecr.lifecycle_policy_document}."
  }
}

# An operator-supplied document must WIN. Without this the variable could be silently ignored and
# every tenant would be stuck on the default — the same class of dead-input bug as the missing
# repository_lifecycle_policy that caused this issue.
run "an_explicit_lifecycle_policy_overrides_the_default" {
  command = plan

  variables {
    aws_account_id                  = "270587882865"
    provision_ecr                   = true
    ecr_names_map                   = { app = "app-images" }
    ecr_repository_lifecycle_policy = "{\"rules\":[{\"rulePriority\":1,\"description\":\"operator supplied policy, padded past the AWS 100-character minimum\",\"selection\":{\"tagStatus\":\"untagged\",\"countType\":\"sinceImagePushed\",\"countUnit\":\"days\",\"countNumber\":1},\"action\":{\"type\":\"expire\"}}]}"
  }

  assert {
    condition     = can(regex("operator supplied policy", module.ecr.lifecycle_policy_document))
    error_message = "An explicit ecr_repository_lifecycle_policy must override the default, got ${module.ecr.lifecycle_policy_document}."
  }
}

# An EMPTY string must fall back to the default rather than being passed through. "" is precisely
# what the upstream module defaults to and precisely what AWS rejects, so coalesce()-style handling
# that treats "" as a present value would reintroduce the original bug through a different door.
run "an_empty_lifecycle_policy_falls_back_to_the_default" {
  command = plan

  variables {
    aws_account_id                  = "270587882865"
    provision_ecr                   = true
    ecr_names_map                   = { app = "app-images" }
    ecr_repository_lifecycle_policy = ""
  }

  assert {
    condition     = length(module.ecr.lifecycle_policy_document) >= 100
    error_message = "An empty ecr_repository_lifecycle_policy must fall back to the default, not pass \"\" through to AWS. Got ${length(module.ecr.lifecycle_policy_document)} characters."
  }
}
