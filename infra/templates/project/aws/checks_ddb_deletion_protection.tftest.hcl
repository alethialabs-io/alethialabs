# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that a DynamoDB table a caller describes WITHOUT mentioning deletion protection plans with
# deletion protection OFF — and that a caller who asks for it on still gets it.
#
# This is a destroy-path gate, not a feature gate. `deletion_protection_enabled` defaulted to `true`
# on both root table variables, and packages/core/cloud/aws_provider.go's buildDDBTables has never
# emitted the key — so every table in every AWS project was built protected, DeleteTable was
# refused, `tofu destroy` errored on the table, and the RDS/ElastiCache ENIs behind it kept the
# subnets and the VPC alive. The symptom presented as a leaky sweeper; the cause was one default.
#
# The OFF run is the one that matters and it deliberately omits the key entirely, because "omitted"
# is the only shape the emitter ever produces. A test that set the field explicitly would pass just
# as happily against the broken default.
#
# The ON run is not decoration either: without it, deleting the argument from
# modules/dynamodb/dynamodb.tf would leave the OFF run green while the switch had stopped existing.
#
# Providers are mocked and every other component is off, so this needs no credentials and runs on
# any PR. `modules/**/*.tftest.hcl` is silently never executed by `tofu test`, which is why this
# sits at the root rather than beside the module.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

# main.tf declares a SECOND aws provider (alias `virginia`, for the WAF module). mock_provider mocks
# one provider CONFIGURATION, not one provider type, so without this the aliased one still
# authenticates against whatever ambient credentials the runner happens to hold.
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

  # DynamoDB is the whole subject; everything else is off so the graph plans without credentials.
  # `environment = "production"` is deliberate: the trap has to be gone in the environment where a
  # protective default is most tempting, not only in a throwaway one.
  ddb_create        = true
  ddb_global_create = false
  provision_eks     = false
  provision_ecr     = false
  provision_sqs     = false
  create_rds        = false

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
  sqs_queues                       = {}
  waf_logging_enabled              = false
  waf_log_retention_days           = 14
  waf_sampled_requests_enabled     = false
  waf_webacl_cloudwatch_enabled    = false

  ddb_table_configuration        = []
  ddb_global_table_configuration = []
}

################################################################################
# The destroy-path pin
################################################################################

# The shape the emitter actually produces: no deletion_protection_enabled key at all. This run is
# what fails if the root default is ever restored to `true`.
run "a_table_that_never_mentions_deletion_protection_plans_unprotected" {
  command = plan

  variables {
    ddb_table_configuration = [{
      table_name_suffix = "events"
      hash_key          = "pk"
      range_key         = "sk"
      hash_key_type     = "S"
      range_key_type    = "S"
    }]
  }

  assert {
    condition     = module.dynamodb[0].table_deletion_protection["events"] == false
    error_message = "A table described without a deletion-protection value must plan UNPROTECTED. It planned protected, which means `tofu destroy` will be refused on the table and every environment carrying a nosql component becomes undestroyable — the customer has no console control to turn it off."
  }
}

# Same for a global table. Its replicas are removed through the same DeleteTable call, so a
# protected global table wedges the destroy in every replica region at once.
run "a_global_table_that_never_mentions_deletion_protection_plans_unprotected" {
  command = plan

  variables {
    ddb_create        = false
    ddb_global_create = true
    ddb_global_table_configuration = [{
      table_type        = "global"
      table_name_suffix = "sessions"
      hash_key          = "pk"
      range_key         = "sk"
      hash_key_type     = "S"
      range_key_type    = "S"
      replicas          = ["eu-west-1"]
    }]
  }

  assert {
    condition     = module.global_dynamodb[0].table_deletion_protection["sessions"] == false
    error_message = "A global table described without a deletion-protection value must plan UNPROTECTED; protected, its destroy is refused in the primary AND every replica region."
  }
}

# The other half. Without this, removing `deletion_protection_enabled` from
# modules/dynamodb/dynamodb.tf would leave the run above green while the setting had ceased to
# exist — the switch-that-does-nothing shape, arrived at from the opposite direction.
run "a_table_that_asks_for_protection_still_gets_it" {
  command = plan

  variables {
    ddb_table_configuration = [{
      table_name_suffix           = "ledger"
      hash_key                    = "pk"
      range_key                   = "sk"
      hash_key_type               = "S"
      range_key_type              = "S"
      deletion_protection_enabled = true
    }]
  }

  assert {
    condition     = module.dynamodb[0].table_deletion_protection["ledger"] == true
    error_message = "A caller asking for deletion protection must still get it — the field is reachable per table through provider_config passthrough, and it is the escape hatch that makes the safe default acceptable."
  }
}
