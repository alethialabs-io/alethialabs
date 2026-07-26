# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# RDS + S3 data-tier invariants.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new checks for THIS feature here; never append to checks.tf.


# When an RDS cluster is created, a database name must be supplied.
check "rds_db_name_present_when_created" {
  assert {
    condition     = !var.create_rds || length(trimspace(var.rds_config.db_name)) > 0
    error_message = "create_rds is true but rds_config.db_name is empty; set a database name."
  }
}


# Keyless RDS IAM auth (#722): when the RDS engine flag is on, the app IRSA role must also be created
# (one iam_auth toggle drives both, via the provider tfvars) — otherwise the DB accepts IAM tokens but
# no workload identity can mint one and the keyless binding fails closed.
check "keyless_rds_iam_irsa_wired" {
  assert {
    condition     = !var.rds_iam_auth_enabled || length(module.rds_iam_auth) == 1
    error_message = "rds_iam_auth_enabled is on but the app RDS-IAM IRSA role is missing; set rds_iam_irsa (the iam_auth toggle should drive both)."
  }
}


# Every S3 bucket must keep public access blocked (block_public_acls / restrict_public_buckets must
# not be explicitly false). null is allowed — the module defaults those to a blocked posture.
check "s3_buckets_block_public_access" {
  assert {
    condition = alltrue([
      for b in var.bucket_configuration :
      b.block_public_acls != false && b.restrict_public_buckets != false
    ])
    error_message = "Every S3 bucket must keep block_public_acls and restrict_public_buckets non-false (public access blocked)."
  }
}
