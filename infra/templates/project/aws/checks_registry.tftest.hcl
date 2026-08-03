# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that the canvas's two registry switches reach the ECR module with DIFFERENT values in their
# two positions, and that the empty case emits the safe default rather than a silent downgrade.
#
# What this file can and cannot see, said plainly, because the difference decides how much it proves:
# `terraform-aws-modules/ecr/aws` is a third-party module, and no test can address a resource inside
# a module, so the assertions read `module.ecr.image_settings` — the values crossing the boundary
# INTO it, exposed for exactly this reason, as `lifecycle_policy_document` already is. That the
# upstream module puts them on `aws_ecr_repository.image_tag_mutability` and
# `image_scanning_configuration.scan_on_push` is ecr.tf:18-19 handing them to that module's own
# passthrough arguments, and it is what the offer-parity guard's template check reads statically.
#
# The half no static reader can have is the one asserted here: that the ON and OFF positions produce
# DIFFERENT values, which one is which, and — the run that matters most — what an unasked project
# gets. The template has always defaulted to IMMUTABLE + scan-on-push, so every repository Alethia
# has built has both ON; emitting `false` for a project with no native registry component would
# rewrite `image_tag_mutability` to MUTABLE and switch scanning off on the first apply after this
# change, with nobody having touched a switch.
#
# At the ROOT on purpose: `modules/**/*.tftest.hcl` is silently never executed.
#
# Providers are mocked and every provisionable component but ECR is off, so this needs no
# credentials and runs on any PR.

mock_provider "aws" {
  # Same single mock as checks_account_and_ecr.tftest.hcl, and for the same reason: module.ecr feeds
  # a generated string straight into aws_ecr_repository_policy.this.policy, which the provider parses
  # before any API call and rejects as invalid JSON, stopping the plan short of these assertions.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

# main.tf declares a SECOND aws provider (alias `virginia`, for the WAF module). mock_provider mocks
# one provider CONFIGURATION, not one provider type, so without this the aliased one still tries to
# authenticate even with every WAF flag off.
mock_provider "aws" {
  alias = "virginia"
}

mock_provider "random" {}

variables {
  region         = "us-east-1"
  vpc_cidr       = "10.0.0.0/16"
  environment    = "production"
  project_name   = "alethia-nl"
  aws_account_id = "270587882865"

  # ECR is the subject; nothing else needs to plan to decide it.
  provision_eks = false
  create_rds    = false
  provision_ecr = true
  ecr_names_map = { app = "app-images" }

  # Declared with no default — a plan cannot start without them, and they are inert here.
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

# BOTH SWITCHES ON — what the provider emits when a user leaves them alone, since both columns
# default to true.
run "both_switches_on_reach_the_ecr_module" {
  command = plan

  variables {
    ecr_repo_settings = {
      app = { immutable_tags = true, vulnerability_scanning = true }
    }
  }

  assert {
    condition     = module.ecr.image_settings["app"].image_tag_mutability == "IMMUTABLE"
    error_message = "immutable_tags ON must reach the ECR module as IMMUTABLE; got ${module.ecr.image_settings["app"].image_tag_mutability}."
  }

  assert {
    condition     = module.ecr.image_settings["app"].image_scan_on_push == true
    error_message = "vulnerability_scanning ON must reach the ECR module as scan_on_push = true."
  }
}

# BOTH SWITCHES OFF — the half that distinguishes a wired switch from a hardcoded one. A template
# that pinned IMMUTABLE and scan-on-push would pass the run above and fail here, which is the whole
# reason both directions are asserted.
run "both_switches_off_reach_the_ecr_module" {
  command = plan

  variables {
    ecr_repo_settings = {
      app = { immutable_tags = false, vulnerability_scanning = false }
    }
  }

  assert {
    condition     = module.ecr.image_settings["app"].image_tag_mutability == "MUTABLE"
    error_message = "immutable_tags OFF must reach the ECR module as MUTABLE — the OFF position has to plan differently from ON. Got ${module.ecr.image_settings["app"].image_tag_mutability}."
  }

  assert {
    condition     = module.ecr.image_settings["app"].image_scan_on_push == false
    error_message = "vulnerability_scanning OFF must reach the ECR module as scan_on_push = false."
  }
}

# THE RUN THE REGISTRY-WIDE SHAPE COULD NOT EXPRESS, and the reason these settings are a map.
#
# The canvas offers both switches PER registry component, and `aws_ecr_repository` accepts both PER
# repository. An earlier cut of #1811 folded every component into one registry-wide value with an OR,
# so two components with opposite answers both got the safer one — silently overruling the user who
# asked for MUTABLE, whose next `docker push` to an existing tag then fails with nothing on the
# canvas to explain why. Two repositories, opposite answers, and they stay opposite.
run "two_repositories_with_opposite_settings_stay_opposite" {
  command = plan

  variables {
    ecr_names_map = { lax = "lax-images", strict = "strict-images" }
    ecr_repo_settings = {
      lax    = { immutable_tags = false, vulnerability_scanning = false }
      strict = { immutable_tags = true, vulnerability_scanning = true }
    }
  }

  assert {
    condition     = module.ecr.image_settings["lax"].image_tag_mutability == "MUTABLE"
    error_message = "The lax repository was overruled by its neighbour: got ${module.ecr.image_settings["lax"].image_tag_mutability}, want MUTABLE."
  }

  assert {
    condition     = module.ecr.image_settings["strict"].image_tag_mutability == "IMMUTABLE"
    error_message = "The strict repository was overruled by its neighbour: got ${module.ecr.image_settings["strict"].image_tag_mutability}, want IMMUTABLE."
  }

  assert {
    condition     = module.ecr.image_settings["lax"].image_scan_on_push == false && module.ecr.image_settings["strict"].image_scan_on_push == true
    error_message = "Scanning must be decided per repository — both repositories resolved to the same answer."
  }
}

# THE UPGRADE-SAFETY RUN. A snapshot that names no per-repository settings — which is every snapshot
# written before #1811, and every project whose registries are all pluggable — must plan the SAFE
# setting from the project-wide defaults. If either default ever moves, this fails here rather than
# turning a live registry mutable.
run "an_unasked_project_keeps_the_safe_default" {
  command = plan

  assert {
    condition     = module.ecr.image_settings["app"].image_tag_mutability == "IMMUTABLE"
    error_message = "The tag-mutability default must stay IMMUTABLE — every repository built so far has it, and lowering the default downgrades all of them on the next apply. Got ${module.ecr.image_settings["app"].image_tag_mutability}."
  }

  assert {
    condition     = module.ecr.image_settings["app"].image_scan_on_push == true
    error_message = "The scan-on-push default must stay true — lowering it silently switches scanning off on every existing repository."
  }
}

# A repository named by `ecr_names_map` but absent from `ecr_repo_settings` falls back to the
# project-wide defaults rather than to `false`. This is the mixed case a real project hits first:
# a repo-sourced SERVICE gets a repository from buildECRNamesMap and no settings entry, because a
# service has no registry switches to answer.
run "a_repository_with_no_settings_entry_takes_the_project_default" {
  command = plan

  variables {
    ecr_names_map = { app = "app-images", api = "api-images" }
    ecr_repo_settings = {
      app = { immutable_tags = false, vulnerability_scanning = false }
    }
  }

  assert {
    condition     = module.ecr.image_settings["api"].image_tag_mutability == "IMMUTABLE"
    error_message = "An unnamed repository must take the project default, not its neighbour's answer. Got ${module.ecr.image_settings["api"].image_tag_mutability}."
  }

  assert {
    condition     = module.ecr.image_settings["api"].image_scan_on_push == true
    error_message = "An unnamed repository must keep scan-on-push on."
  }
}

# A value AWS does not accept must be refused at plan. `image_tag_mutability` takes MUTABLE or
# IMMUTABLE; an aggregation bug that emitted "true" would otherwise travel all the way to the API.
run "an_invalid_tag_mutability_blocks_the_plan" {
  command = plan

  variables {
    ecr_repository_image_tag_mutability = "true"
  }

  expect_failures = [var.ecr_repository_image_tag_mutability]
}
