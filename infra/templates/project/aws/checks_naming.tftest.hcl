# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that NAMING-004 produces ElastiCache identifiers AWS will accept.
#
# Four names — the replication group id, the password user's id, the user group id, and the no-op
# default user's id — were composed inside modules/redis with four bare format() calls and no budget
# against ElastiCache's 40-character cap. None of them overflows today, which is precisely the state
# the Azure Key Vault (#1873) and the Alibaba Tablestore instance (#1884) were in until they did.
#
# `restricted-<environment>-<user>-user` is the one to watch: it renders 37 of 40 on the e2e nightly.
# A GitHub run id is 11 digits today and only grows.
#
# What has to be pinned is the CONSTRUCTION: that a name which fits is left BYTE-IDENTICAL (renaming
# a replication group replaces the cache; renaming a user or user group breaks every client
# credential), that an overflowing one lands inside 40, and that truncation cannot make two
# environments collide onto one cache.
#
# The digests below are literal on purpose. Recomputing sha256 inside the assertion would pass
# against a broken derivation, since both sides would drift together.
#
# The mocks are lifted from checks_cluster_optional.tftest.hcl, including the aliased `virginia`
# provider — mock_provider mocks one provider CONFIGURATION, not one provider type, so without the
# alias the second one still tries to authenticate. Providers are mocked and every component is off,
# so this needs no credentials and runs on any PR.

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

  # NAMING-004 is decided from plain variables, before any resource exists — that is the property
  # that makes it testable at all. No cluster and no cache are needed to reach it, and
  # create_elasticache_redis stays off so the derivation is asserted directly at the root rather
  # than through a module that would need the whole ElastiCache surface mocked.
  provision_eks            = false
  create_elasticache_redis = false

  provision_ecr          = false
  create_rds             = false
  rds_iam_irsa           = false
  rds_iam_auth_enabled   = false
  enable_karpenter       = false
  registry_pull_provider = "native"

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
# 1. A name that FITS is never touched
################################################################################

# The backward-compatibility guarantee, over all four at once. Every identifier that exists today is
# inside the cap, so the derivation must leave them byte-identical — a changed replication group id
# REPLACES the cache, and a changed user id invalidates the credential every client holds.
run "short_names_are_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia"
    environment  = "prod"
  }

  assert {
    condition     = local.aws_redis_name == "redis-ue1-prod-alethia"
    error_message = "Replication group id must be kept verbatim, got ${local.aws_redis_name}."
  }

  assert {
    condition     = local.aws_redis_user_name == "redis-ue1-prod-alethia"
    error_message = "User name must be kept verbatim, got ${local.aws_redis_user_name}."
  }

  assert {
    condition     = local.aws_redis_user_group_name == "ue1-prod-alethia"
    error_message = "User group id must be kept verbatim, got ${local.aws_redis_user_group_name}."
  }

  assert {
    condition     = local.aws_redis_default_user_id == "restricted-prod-default-user"
    error_message = "Default user id must be kept verbatim, got ${local.aws_redis_default_user_id}."
  }
}

# THE case from #1886 — the e2e nightly's own environment, "<run_id>-<attempt>". All four fit, and
# the point of pinning them is that they must KEEP fitting, byte for byte: these are the names a
# live cache carries. The lengths are asserted alongside so the margins are visible in the diff
# rather than inferred: 37 of 40 on the default user id is three characters.
run "the_e2e_nightly_keeps_every_name_readable" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "30790581805-1"
  }

  assert {
    condition     = local.aws_redis_name == "redis-ue1-30790581805-1-alethia-nl" && length(local.aws_redis_name) == 34
    error_message = "Replication group id: expected the readable 34-char form, got ${local.aws_redis_name} (${length(local.aws_redis_name)} chars)."
  }

  assert {
    condition     = local.aws_redis_user_group_name == "ue1-30790581805-1-alethia-nl" && length(local.aws_redis_user_group_name) == 28
    error_message = "User group id: expected the readable 28-char form, got ${local.aws_redis_user_group_name} (${length(local.aws_redis_user_group_name)} chars)."
  }

  assert {
    condition     = local.aws_redis_default_user_id == "restricted-30790581805-1-default-user" && length(local.aws_redis_default_user_id) == 37
    error_message = "Default user id: expected the readable 37-char form — three characters inside the cap — got ${local.aws_redis_default_user_id} (${length(local.aws_redis_default_user_id)} chars)."
  }
}

################################################################################
# 2. The exact boundary, per name
#
# 40 is legal, so a name sitting exactly on it must NOT fall back. An off-by-one here would rename
# every identifier at the cap — which is the failure the fix is supposed to prevent, arriving from
# the other direction.
################################################################################

run "a_replication_group_id_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west1"
  }

  assert {
    condition     = local.aws_redis_name == "redis-ue1-production-eu-west1-alethia-nl" && length(local.aws_redis_name) == 40
    error_message = "A replication group id of exactly 40 characters must keep the readable form, got ${local.aws_redis_name} (${length(local.aws_redis_name)} chars)."
  }
}

run "a_replication_group_id_one_over_the_cap_falls_back" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1"
  }

  assert {
    condition     = local.aws_redis_name == "redis-ue1-production-eu-west-1-a-2a2b923" && length(local.aws_redis_name) == 40
    error_message = "A 41-character replication group id must fall back to truncate-plus-digest, got ${local.aws_redis_name}."
  }
}

# The same boundary for the default user id, which reaches it from a much shorter environment
# because "restricted-" + "-default-user" is 24 fixed characters.
run "a_default_user_id_exactly_at_the_cap_is_kept_verbatim" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-we"
  }

  assert {
    condition     = local.aws_redis_default_user_id == "restricted-production-eu-we-default-user" && length(local.aws_redis_default_user_id) == 40
    error_message = "A default user id of exactly 40 characters must keep the readable form, got ${local.aws_redis_default_user_id} (${length(local.aws_redis_default_user_id)} chars)."
  }
}

run "a_default_user_id_one_over_the_cap_falls_back" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-wes"
  }

  assert {
    condition     = local.aws_redis_default_user_id == "restricted-production-eu-wes-def-9586a8d" && length(local.aws_redis_default_user_id) == 40
    error_message = "A 41-character default user id must fall back to truncate-plus-digest, got ${local.aws_redis_default_user_id}."
  }
}

# ElastiCache rejects a name ending in a hyphen AND a name containing two consecutive hyphens, so a
# truncation landing on a hyphen must strip it — otherwise the join produces "--" and the name is
# refused for a second, independent reason. This environment puts a hyphen at exactly the
# 32-character mark: `substr(full, 0, 32)` ends "…-eu-west-10-".
#
# The regex strips a RUN, not a single character, which `trimsuffix` would not. That case is not
# reachable from a legal input — an environment carrying "--" or a trailing hyphen is refused by
# check.elasticache_names_shape before it can be truncated — so the run is kept safe by the regex
# rather than proven by a test, and the shape check is what stops the bad input reaching it.
run "a_truncation_landing_on_a_hyphen_trims_it" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-10-abc"
  }

  assert {
    condition     = local.aws_redis_name == "redis-ue1-production-eu-west-10-a75a7ca" && length(local.aws_redis_name) == 39
    error_message = "A truncation landing on a hyphen must trim it, got ${local.aws_redis_name} (${length(local.aws_redis_name)} chars)."
  }

  assert {
    condition     = !can(regex("--", local.aws_redis_name))
    error_message = "ElastiCache rejects two consecutive hyphens; got ${local.aws_redis_name}."
  }
}

# The other half of that guarantee: an environment that WOULD produce "--" is rejected rather than
# silently carried into a live identifier. `ue1-production-eu-west-1--alethia-nl` fits inside 40, so
# no truncation happens and nothing would have caught it — the shape check is the only thing that
# does.
run "an_environment_ending_in_a_hyphen_is_reported_not_carried" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1-"
  }

  expect_failures = [check.elasticache_names_shape]
}

################################################################################
# 3. Truncation must not COLLIDE
#
# The reason the digest is over the FULL name and not the truncated stem. These two environments
# share their first 32 characters exactly — under plain truncation they would resolve to ONE
# replication group and ONE user group, so two environments would share a cache and each other's
# credentials. Two consecutive runs of the nightly are precisely this shape.
################################################################################

run "two_environments_sharing_a_prefix_get_distinct_names_a" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1-aaa-1"
  }

  assert {
    condition     = local.aws_redis_name == "redis-ue1-production-eu-west-1-a-79b0a95"
    error_message = "Expected the -1 environment's own replication group digest, got ${local.aws_redis_name}."
  }

  assert {
    condition     = local.aws_redis_user_group_name == "ue1-production-eu-west-1-aaa-1-a-3289868"
    error_message = "Expected the -1 environment's own user group digest, got ${local.aws_redis_user_group_name}."
  }
}

run "two_environments_sharing_a_prefix_get_distinct_names_b" {
  command = plan

  variables {
    project_name = "alethia-nl"
    environment  = "production-eu-west-1-aaa-2"
  }

  assert {
    condition     = local.aws_redis_name == "redis-ue1-production-eu-west-1-a-51791e9"
    error_message = "Expected the -2 environment's own replication group digest (distinct from -1's 79b0a95), got ${local.aws_redis_name}."
  }

  assert {
    condition     = local.aws_redis_user_group_name == "ue1-production-eu-west-1-aaa-2-a-b4264b8"
    error_message = "Expected the -2 environment's own user group digest (distinct from -1's 3289868), got ${local.aws_redis_user_group_name}."
  }
}

################################################################################
# 4. The user name variable feeds the default user id
#
# `aws_elasticache_user_name` is now declared at the ROOT and passed into the module explicitly,
# rather than left to the module's own default. That is what lets the name be derived where it can
# be tested — and it means the value the name is built from and the value the resource uses cannot
# drift apart. This pins the coupling.
################################################################################

run "the_user_name_variable_reaches_the_derived_default_user_id" {
  command = plan

  variables {
    project_name              = "alethia-nl"
    environment               = "prod"
    aws_elasticache_user_name = "operator"
  }

  assert {
    condition     = local.aws_redis_default_user_id == "restricted-prod-operator-user"
    error_message = "aws_elasticache_user_name must reach the derived default user id, got ${local.aws_redis_default_user_id}."
  }
}
