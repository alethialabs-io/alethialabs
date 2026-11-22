# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariant assertions. A `check` block WARNS: `tofu plan` still exits 0 with the message
# printed. What must be UN-APPLIABLE rather than noisy is enforced elsewhere and says so: the account
# pin is the provider's allowed_account_ids, the not-the-platform-account rule is a precondition on
# the key, the bucket and the writer, and the key and bucket carry prevent_destroy.
#
# checks.tftest.hcl runs every check below on the committed posture (a failing check fails a test
# run) and makes the ones that read live values fire.

locals {
  # The posture of the stack's SOURCE, for properties a plan cannot show: which resource TYPES exist
  # and which lifecycle meta-arguments are set. Every *.tf file under this directory, bootstrap
  # included. The patterns are written so that this file's own text does not match them.
  stack_source           = join("\n", [for f in sort(fileset(path.module, "**/*.tf")) : file("${path.module}/${f}")])
  access_key_resource_re = "resource\\s+\"aws_iam_(access_key|user_login_profile|service_specific_credential)\""
  secret_value_re        = "resource\\s+\"aws_secretsmanager_secret_version\""
  prevent_destroy_re     = "prevent_destroy\\s*=\\s*true"

  writer_statements = jsondecode(data.aws_iam_policy_document.writer.json).Statement
  writer_allowed    = toset(flatten([for s in local.writer_statements : s.Action if s.Effect == "Allow"]))
  reader_allowed    = toset(flatten([for s in jsondecode(data.aws_iam_policy_document.reader.json).Statement : s.Action if s.Effect == "Allow"]))
  drill_allowed     = toset(flatten([for s in jsondecode(data.aws_iam_policy_document.drill.json).Statement : s.Action if s.Effect == "Allow"]))
  launcher_allowed  = setunion(toset(local.launcher_run_actions), toset(flatten([for s in jsondecode(data.aws_iam_policy_document.launcher.json).Statement : s.Action if s.Effect == "Allow"])))
  non_admin_allowed = setunion(local.writer_allowed, local.reader_allowed, local.drill_allowed, local.launcher_allowed)
  bucket_statements = jsondecode(data.aws_iam_policy_document.bucket.json).Statement
}

# ── The account ──────────────────────────────────────────────────────────────────────────────────
check "backup_account_is_the_dedicated_one" {
  assert {
    condition = alltrue([
      data.aws_caller_identity.current.account_id == var.backup_account_id,
      data.aws_caller_identity.current.account_id != var.alethia_account_id,
    ])
    error_message = "the provider is operating in ${data.aws_caller_identity.current.account_id}, not the dedicated backup account ${var.backup_account_id} (or that is the Alethia platform account)."
  }
}

# ── No secret in the state ───────────────────────────────────────────────────────────────────────
check "no_credential_or_secret_value_resource" {
  assert {
    condition = alltrue([
      length(regexall(local.access_key_resource_re, local.stack_source)) == 0,
      length(regexall(local.secret_value_re, local.stack_source)) == 0,
    ])
    error_message = "a *.tf file here declares an access key, login profile, service credential or secret VALUE. Each writes a secret into the state; the writer key and the drill identity are created out of band (README)."
  }
}

# ── The writer ───────────────────────────────────────────────────────────────────────────────────
check "writer_can_only_put_get_list" {
  assert {
    condition = alltrue([
      local.writer_allowed == toset(["s3:PutObject", "s3:GetObject", "s3:ListBucket", "kms:GenerateDataKey", "kms:Decrypt"]),
      length([for a in local.writer_allowed : a if strcontains(lower(a), "delete") || strcontains(a, "*")]) == 0,
    ])
    error_message = "backup-writer may be granted exactly s3:PutObject, s3:GetObject, s3:ListBucket and (through S3) kms:GenerateDataKey + kms:Decrypt — no delete, no wildcard."
  }
}

check "writer_is_locked_to_the_box" {
  assert {
    condition = alltrue([
      for s in local.writer_statements : strcontains(jsonencode(s), "aws:SourceIp") || strcontains(jsonencode(s), "kms:ViaService")
    ])
    error_message = "every writer statement must carry the aws:SourceIp lock, or (for KMS) be confined to calls made through S3."
  }
}

# ── Nobody but an admin can destroy ──────────────────────────────────────────────────────────────
check "no_non_admin_identity_can_delete_or_change_retention" {
  assert {
    condition = length([
      for a in local.non_admin_allowed : a
      if strcontains(lower(a), "delete") || strcontains(lower(a), "retention") || strcontains(lower(a), "legalhold") || a == "s3:*" || a == "*"
    ]) == 0
    error_message = "no identity this stack creates (writer, reader, drill, launcher) may be granted a delete, a retention or legal-hold change, or a wildcard."
  }
}

# ── The bucket ───────────────────────────────────────────────────────────────────────────────────
check "object_lock_is_compliance_15_days" {
  assert {
    condition = alltrue([
      aws_s3_bucket.backup.object_lock_enabled,
      aws_s3_bucket_object_lock_configuration.backup.rule[0].default_retention[0].mode == "COMPLIANCE",
      aws_s3_bucket_object_lock_configuration.backup.rule[0].default_retention[0].days == 15,
    ])
    error_message = "the bucket must be created with Object Lock, default retention COMPLIANCE for 15 days (decision A-2)."
  }
}

check "lifecycle_never_targets_a_locked_version" {
  assert {
    condition = alltrue([
      local.daily_days >= local.lock_days,
      local.noncurrent_days > local.lock_days,
    ])
    error_message = "daily_days must be >= lock_days and noncurrent_days > lock_days, or lifecycle rules would target versions Object Lock still protects."
  }
}

check "bucket_policy_denies_plain_http" {
  assert {
    condition = length([
      for s in local.bucket_statements : s
      if s.Effect == "Deny" && strcontains(jsonencode(s), "aws:SecureTransport") && strcontains(jsonencode(s), "\"false\"")
    ]) == 1
    error_message = "the bucket policy must deny every request with aws:SecureTransport = false."
  }
}

check "key_and_bucket_cannot_be_destroyed_by_tofu" {
  assert {
    condition = alltrue([
      length(regexall(local.prevent_destroy_re, file("${path.module}/kms.tf"))) == 1,
      length(regexall(local.prevent_destroy_re, file("${path.module}/bucket.tf"))) == 1,
    ])
    error_message = "kms.tf and bucket.tf must each carry prevent_destroy = true: a destroyed key makes every locked copy unreadable."
  }
}

# ── Built names match the real ones ──────────────────────────────────────────────────────────────
check "built_arns_match_the_created_ones" {
  assert {
    condition = alltrue([
      aws_iam_openid_connect_provider.github.arn == local.github_oidc_provider_arn,
      aws_iam_user.writer.arn == local.writer_user_arn,
      aws_iam_role.reader.arn == local.reader_role_arn,
      aws_iam_role.launcher.arn == local.launcher_role_arn,
      aws_iam_role.drill.arn == local.drill_role_arn,
    ])
    error_message = "a policy names a principal by a BUILT ARN that differs from the one IAM created; the bucket policy would deny that principal everything."
  }
}
