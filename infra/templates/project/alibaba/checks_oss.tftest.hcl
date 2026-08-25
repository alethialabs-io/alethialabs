# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that an OSS bucket PLANS at all, and that `bucket:encryption_enabled` reaches the resource.
#
# Two defects meet in this file.
#
# #1834 — the provider emitted `name_suffix` while modules/oss keyed on `b.name`, so every Alibaba
# project carrying a bucket died at plan with "This object does not have an attribute named name".
# Neither side was wrong on its own, which is exactly why nothing caught it: `tofu validate` never
# expands a for_each, the Go tests stop at "is the key emitted", and the module variable was
# `list(any)`, which declares no fields and so could not disagree with anything. The variable is a
# typed object now, and this suite is what proves the two halves still line up.
#
# #1814 — OSS applies NO default server-side encryption to a new bucket. GetBucketEncryption answers
# 400 NoSuchServerSideEncryptionRule and PutBucket's x-oss-server-side-encryption header carries no
# documented default, on a page where every other optional header states one. So the AWS/GCP/Azure
# reasoning ("the service encrypts unconditionally, the switch is cosmetic") does not transfer: an
# uncarried switch here means unencrypted objects.
#
# BOTH DIRECTIONS ARE ASSERTED. A suite that only pins the ON position passes just as happily for a
# template that hardcoded encryption on, which would prove nothing about the switch and would also
# be a lie about what the canvas controls.
#
# This has to live at the ROOT: `modules/**/*.tftest.hcl` is silently never executed.
#
# Providers are mocked, so this needs no credentials and runs on any PR.

mock_provider "alicloud" {
  # ACK's create API resolves a ROS component by EXACT version string, so ack-version.tf resolves the
  # declared MINOR against what the region offers. Same trap the alicloud_zones mock above documents:
  # the mock's default for a computed LIST is an EMPTY list, so without this every plan fails the
  # terraform_data.ack_version_resolvable precondition — which is the guard doing its job, not a bug.
  # The patch numbers are the ones eu-central-1 actually offered on 2026-08-25.
  mock_data "alicloud_cs_kubernetes_version" {
    defaults = {
      metadata = [
        { version = "1.36.2-aliyun.1", runtime = [] },
        { version = "1.35.7-aliyun.1", runtime = [] },
        { version = "1.34.10-aliyun.1", runtime = [] },
      ]
    }
  }

  # PLAN-OUT SAFETY (#621) keeps the zone COUNT static, but the zone IDS still come from this data
  # source, and modules/network calls element(local.zones, count.index) on them. The mock's default
  # for a computed LIST is an empty list, and element() on an empty list is a hard error — so the
  # zones have to be populated for any plan to complete, even one that only cares about buckets.
  mock_data "alicloud_zones" {
    defaults = {
      zones = [
        {
          id                          = "eu-central-1a"
          local_name                  = "eu-central-1a"
          available_disk_categories   = ["cloud_essd"]
          available_instance_types    = ["ecs.g6.large"]
          available_resource_creation = ["VSwitch"]
          multi_zone_ids              = []
          slb_slave_zone_ids          = []
        },
        {
          id                          = "eu-central-1b"
          local_name                  = "eu-central-1b"
          available_disk_categories   = ["cloud_essd"]
          available_instance_types    = ["ecs.g6.large"]
          available_resource_creation = ["VSwitch"]
          multi_zone_ids              = []
          slb_slave_zone_ids          = []
        },
      ]
    }
  }
}

mock_provider "random" {}

variables {
  project_name = "alethia-nl"
  region       = "eu-central-1"
  environment  = "production"

  # Buckets are independent of the cluster, and a cluster-less plan is far cheaper to expand.
  provision_ack = false
  create_oss    = true
}

################################################################################
# 1. The shape the provider actually emits must plan
################################################################################

# The entry below is `buildOSSBuckets` output verbatim, key for key. If either side is renamed
# without the other, this run fails with a declaration error instead of shipping a template that
# cannot plan.
run "the_emitted_bucket_shape_plans" {
  command = plan

  variables {
    oss_buckets = [{
      name_suffix   = "assets"
      acl           = "private"
      versioning    = false
      cors_origins  = []
      sse_algorithm = "AES256"
    }]
  }

  assert {
    condition     = length(module.oss) == 1
    error_message = "create_oss = true must instantiate the OSS module."
  }

  # OSS bucket names are globally unique across all of Alibaba Cloud, so the suffix must be composed
  # with the project prefix rather than used raw. Pinned as an exact string: "it contains the suffix"
  # would also pass for the un-prefixed name that can never be created.
  assert {
    condition     = module.oss[0].bucket_names == ["alethia-nl-production-assets"]
    error_message = "The bucket name must be name_prefix-name_suffix — a bare suffix is not a globally-available OSS bucket name."
  }
}

################################################################################
# 2. The switch, both ways
################################################################################

# ON. The canvas's default-on encryption switch must reach the resource as a real rule, with the
# free SSE-OSS algorithm rather than the billed KMS one.
run "encryption_on_sets_an_sse_rule" {
  command = plan

  variables {
    oss_buckets = [{
      name_suffix   = "assets"
      acl           = "private"
      versioning    = false
      cors_origins  = []
      sse_algorithm = "AES256"
    }]
  }

  assert {
    condition     = module.oss[0].bucket_encryption["assets"] == "AES256"
    error_message = "The default algorithm must be AES256 (SSE-OSS, free of charge), not KMS, which bills per API call."
  }
}

# OFF. The half that makes this a test of the SWITCH rather than of encryption: without it, a
# template that hardcoded the rule on would pass everything above.
run "encryption_off_sets_no_sse_rule" {
  command = plan

  variables {
    oss_buckets = [{
      name_suffix   = "assets"
      acl           = "private"
      versioning    = false
      cors_origins  = []
      sse_algorithm = "None"
    }]
  }

  assert {
    condition     = module.oss[0].bucket_encryption["assets"] == "None"
    error_message = "encryption_enabled = false must leave the bucket with NO encryption rule — the two positions must differ, or the switch is decorative."
  }
}

# An explicit KMS choice (reachable through provider_config.encryption_algorithm) must survive to the
# resource. Without this the ON case would be satisfied by a template that ignored the value and
# hardcoded AES256 — a wrong-feature wiring of the same family as #1838.
run "an_explicit_kms_algorithm_is_carried_verbatim" {
  command = plan

  variables {
    oss_buckets = [{
      name_suffix   = "assets"
      acl           = "private"
      versioning    = false
      cors_origins  = []
      sse_algorithm = "KMS"
    }]
  }

  assert {
    condition     = module.oss[0].bucket_encryption["assets"] == "KMS"
    error_message = "An explicitly chosen algorithm must reach the resource unchanged, not be replaced by the default."
  }
}

################################################################################
# 3. The algorithm allow-list is fail-closed
################################################################################

# PutBucketEncryption documents exactly AES256 and KMS, but the Terraform provider's ValidateFunc
# also accepts "SM4" — so without the module's own validation an SM4 reachable through
# provider_config would plan clean and fail at apply with InvalidEncryptionAlgorithmError.
run "an_api_invalid_algorithm_is_refused_at_plan" {
  command = plan

  variables {
    oss_buckets = [{
      name_suffix   = "assets"
      acl           = "private"
      versioning    = false
      cors_origins  = []
      sse_algorithm = "SM4"
    }]
  }

  expect_failures = [var.oss_buckets]
}
