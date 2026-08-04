# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that ordered (FIFO) delivery reaches the SQS queue, and — the half that matters more — that
# turning it OFF changes nothing about a queue that already exists (#1812).
#
# Ordered delivery is not one argument on AWS. `fifo_queue` decides it, the queue's name must then
# end in `.fifo`, and the dead-letter queue must be FIFO too (SQS rejects a standard DLQ behind a
# FIFO queue, so a redrive policy that mixes them fails at APPLY, not at plan). `name` and
# `fifo_queue` are both ForceNew, which makes each of those a separate reason the queue is destroyed
# and recreated — taking every in-flight message with it.
#
# That is why the FIRST run here is the unordered one, asserting the planned names are
# BYTE-IDENTICAL to what the template has always produced. A test that only checked the enabled
# case would pass just as happily for a template that had renamed every queue in the fleet.
#
# Providers are mocked and every other component is off, so this needs no credentials and runs on
# any PR. modules/**/*.tftest.hcl is silently never executed, which is why this lives at the root.

mock_provider "aws" {
  # modules/ecr feeds a generated string straight into a policy document the provider parses before
  # any API call. Nothing here provisions ECR, but the mock is cheap and keeps the plan walking.
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
  aws_account_id = "270587882865"
  region         = "us-east-1"
  vpc_cidr       = "10.0.0.0/16"
  environment    = "production"
  project_name   = "alethia-nl"

  # SQS is the whole subject; everything else is off so the graph stays small enough to plan without
  # credentials. `provision_eks = false` is plannable since #1772.
  provision_sqs = true
  provision_eks = false
  provision_ecr = false
  create_rds    = false

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

  sqs_queues = {}
}

################################################################################
# The anti-destruction pin
################################################################################

# THE assertion this file exists for. Every queue that exists today was built with the switch off,
# and the names below are the names those queues carry. They are HARDCODED rather than recomputed
# from the same expression: restating the derivation would only assert that it equals itself, while
# a literal fails the moment the format string moves — which is a fleet-wide replacement.
run "an_unordered_queue_keeps_todays_name_and_stays_standard" {
  command = plan

  variables {
    sqs_queues = {
      orders = {
        fifo_queue                  = false
        content_based_deduplication = false
        dlq_enable                  = true
      }
    }
  }

  assert {
    condition     = module.sqs_dev[0].queue_names["orders"] == "orders_production"
    error_message = "An unordered queue's name must be byte-identical to today's '<key>_<environment>'. Got ${module.sqs_dev[0].queue_names["orders"]} — every existing SQS queue would be destroyed and recreated."
  }

  assert {
    condition     = module.sqs_dev[0].dlq_names["orders"] == "orders"
    error_message = "An unordered queue's dead-letter queue name must be byte-identical to today's '<key>'. Got ${module.sqs_dev[0].dlq_names["orders"]}."
  }

  assert {
    condition     = module.sqs_dev[0].queue_fifo["orders"] == false && module.sqs_dev[0].dlq_fifo["orders"] == false
    error_message = "With the switch off, neither the queue nor its dead-letter queue may be FIFO."
  }

  # checks_queue.tf's 80-character gate has to RESTATE the name expression, because a count-gated
  # module cannot decide the plan that decides whether to call it. Two copies of one derivation
  # drift, and a gate measuring names nobody builds is a gate that passes while the real name
  # overflows — so the two are asserted equal here rather than trusted to stay in step.
  assert {
    condition     = local.sqs_queue_names["orders"] == module.sqs_dev[0].queue_names["orders"] && local.sqs_dlq_names["orders"] == module.sqs_dev[0].dlq_names["orders"]
    error_message = "The root's name derivation (checks_queue.tf) has drifted from the module's; the length gate is now measuring names the template does not build."
  }
}

# The same shape with the key absent entirely — a queue whose tfvars entry predates ordered
# delivery. `try(q.fifo_queue, false)` is what makes this plan at all, and the names must be the
# same ones again: an upgrade must not move a single queue.
run "a_queue_with_no_ordering_key_at_all_keeps_todays_name" {
  command = plan

  variables {
    sqs_queues = {
      orders = { dlq_enable = true }
    }
  }

  assert {
    condition     = module.sqs_dev[0].queue_names["orders"] == "orders_production"
    error_message = "A queue entry that predates ordered delivery must plan the name it already has, got ${module.sqs_dev[0].queue_names["orders"]}."
  }

  assert {
    condition     = module.sqs_dev[0].queue_fifo["orders"] == false
    error_message = "An absent fifo_queue key must default to false, not to the provider default."
  }
}

################################################################################
# The switch ON — a different plan, and the right one
################################################################################

# The other direction. Asserted against the ON case above rather than alone: a template that had
# hardcoded FIFO on would pass this run and fail the unordered runs, and one that dropped the switch
# entirely would pass the unordered runs and fail this one. Neither half proves anything by itself.
run "an_ordered_queue_is_fifo_and_carries_the_suffix" {
  command = plan

  variables {
    sqs_queues = {
      orders = {
        fifo_queue                  = true
        content_based_deduplication = true
        dlq_enable                  = true
      }
    }
  }

  assert {
    condition     = module.sqs_dev[0].queue_fifo["orders"] == true
    error_message = "Ordered delivery must reach aws_sqs_queue.fifo_queue — this is the argument that implements it."
  }

  # SQS REFUSES a FIFO queue whose name does not end in `.fifo`, so the suffix is not cosmetic: the
  # apply fails without it.
  assert {
    condition     = module.sqs_dev[0].queue_names["orders"] == "orders_production.fifo"
    error_message = "A FIFO queue's name must end in '.fifo' — SQS rejects it otherwise. Got ${module.sqs_dev[0].queue_names["orders"]}."
  }

  # "The dead-letter queue of a FIFO queue must also be a FIFO queue." Without the mirror,
  # aws_sqs_queue_redrive_policy is rejected mid-apply — plan-clean, apply-broken.
  assert {
    condition     = module.sqs_dev[0].dlq_fifo["orders"] == true
    error_message = "The dead-letter queue of a FIFO queue must also be FIFO, or SQS rejects the redrive policy at apply."
  }

  assert {
    condition     = module.sqs_dev[0].dlq_names["orders"] == "orders.fifo"
    error_message = "A FIFO dead-letter queue's name must end in '.fifo' too. Got ${module.sqs_dev[0].dlq_names["orders"]}."
  }

  # The same root-vs-module agreement as the unordered run, on the branch where the two derivations
  # actually differ — this is where a drifted copy would show up first.
  assert {
    condition     = local.sqs_queue_names["orders"] == module.sqs_dev[0].queue_names["orders"] && local.sqs_dlq_names["orders"] == module.sqs_dev[0].dlq_names["orders"]
    error_message = "The root's name derivation (checks_queue.tf) has drifted from the module's on the FIFO branch; the length gate is measuring names the template does not build."
  }
}

################################################################################
# The 80-character cap, which the `.fifo` suffix eats into
################################################################################

# The boundary from the ACCEPTING side. 64-character key + "_production" + ".fifo" = exactly 80, the
# longest ordered queue SQS will take. Without this run the guard could be satisfied by refusing
# everything, and an off-by-one that rejected legal names would go unnoticed until it blocked a
# real tenant.
run "an_ordered_name_at_exactly_eighty_characters_is_accepted" {
  command = plan

  variables {
    sqs_queues = {
      # 64 characters.
      "queue-0123456789queue-0123456789queue-0123456789queue-0123456789" = {
        fifo_queue = true
      }
    }
  }

  assert {
    condition     = length(module.sqs_dev[0].queue_names["queue-0123456789queue-0123456789queue-0123456789queue-0123456789"]) == 80
    error_message = "This name is exactly at the SQS cap and must be accepted."
  }
}

# One character over must BLOCK the plan, and block it with a message that names the cause. The
# check states the violation in the plan output; the terraform_data precondition is the gate that
# actually refuses, because a `check` block only ever WARNS. Both are expected, so neither can be
# quietly dropped.
#
# This is reachable only through ordered delivery: at 65 characters the STANDARD name
# ("<key>_production", 76) is comfortably legal, and it is the 5-character `.fifo` suffix that
# pushes it to 81. A user flipping the switch on an existing queue is exactly the path.
run "an_ordered_name_one_character_over_blocks_the_plan" {
  command = plan

  variables {
    sqs_queues = {
      # 65 characters.
      "queue-0123456789queue-0123456789queue-0123456789queue-0123456789x" = {
        fifo_queue = true
      }
    }
  }

  expect_failures = [
    check.sqs_queue_names_within_limit,
    terraform_data.sqs_naming_guard,
  ]
}
