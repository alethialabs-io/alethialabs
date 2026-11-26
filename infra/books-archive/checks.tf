# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Loud invariant assertions. A `check` block WARNS: `tofu plan` still exits 0 with the message
# printed. What must be UN-APPLIABLE rather than noisy is enforced elsewhere and says so: the account
# pin is the provider's allowed_account_ids, the not-the-platform-account rule is a precondition on
# every principal-bearing resource, and the key and bucket carry prevent_destroy. ops/plan.sh fails
# the plan step when any check warns, so a warning cannot be scrolled past on the way to apply.
#
# checks.tftest.hcl runs every check below on the committed posture (a failing check fails a test
# run) and makes the ones that read live values fire.

locals {
  # The posture of the stack's SOURCE, for properties a plan cannot show: which resource TYPES exist
  # and which lifecycle meta-arguments are set. The patterns are written so that this file's own text
  # does not match them.
  stack_source           = join("\n", [for f in sort(fileset(path.module, "**/*.tf")) : file("${path.module}/${f}")])
  access_key_resource_re = "resource\\s+\"aws_iam_(access_key|user_login_profile|service_specific_credential|signing_certificate)\""
  secret_value_re        = "resource\\s+\"aws_secretsmanager_secret_version\""
  prevent_destroy_re     = "prevent_destroy\\s*=\\s*true"

  writer_statements = jsondecode(data.aws_iam_policy_document.writer.json).Statement
  writer_allowed    = toset(flatten([for s in local.writer_statements : s.Action if s.Effect == "Allow"]))
  books_statements  = jsondecode(data.aws_iam_policy_document.books.json).Statement
  books_allowed     = toset(flatten([for s in local.books_statements : s.Action if s.Effect == "Allow"]))
  non_admin_allowed = setunion(local.writer_allowed, local.books_allowed)

  # An action a non-admin must never hold: any delete, any retention / legal-hold change, the
  # governance bypass, or a wildcard that would contain them.
  forbidden_action = [
    for a in local.non_admin_allowed : a
    if strcontains(lower(a), "delete") || strcontains(lower(a), "retention") || strcontains(lower(a), "legalhold") || strcontains(lower(a), "bypassgovernance") || strcontains(a, "*")
  ]

  bucket_statements = jsondecode(data.aws_iam_policy_document.bucket.json).Statement
  trust_statements  = jsondecode(data.aws_iam_policy_document.books_trust.json).Statement
}

# ── The account ──────────────────────────────────────────────────────────────────────────────────
check "archive_account_is_the_backup_one" {
  assert {
    condition = alltrue([
      data.aws_caller_identity.current.account_id == var.backup_account_id,
      data.aws_caller_identity.current.account_id != var.alethia_account_id,
    ])
    error_message = "the provider is operating in ${data.aws_caller_identity.current.account_id}, not the backup account ${var.backup_account_id} (or that is the Alethia platform account)."
  }
}

# ── No secret in the state ───────────────────────────────────────────────────────────────────────
check "no_credential_or_secret_value_resource" {
  assert {
    condition = alltrue([
      length(regexall(local.access_key_resource_re, local.stack_source)) == 0,
      length(regexall(local.secret_value_re, local.stack_source)) == 0,
    ])
    error_message = "a *.tf file here declares an access key, login profile, service credential, signing certificate or secret VALUE. Each writes a secret into the state; the writer key is minted by ops/mint-console-writer-key.sh and the connectors value is set out of band (README)."
  }
}

# ── The identities ───────────────────────────────────────────────────────────────────────────────
check "no_identity_can_delete_or_change_retention" {
  assert {
    condition     = length(local.forbidden_action) == 0
    error_message = "books-monthly and console-books-writer may never hold a delete, a retention or legal-hold change, BypassGovernanceRetention or a wildcard. Found: ${join(", ", local.forbidden_action)}."
  }
}

check "writer_can_only_put" {
  assert {
    condition     = local.writer_allowed == toset(["s3:PutObject", "kms:GenerateDataKey", "kms:Decrypt"])
    error_message = "console-books-writer may be granted exactly s3:PutObject and (through S3) kms:GenerateDataKey + kms:Decrypt."
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

check "books_role_grants_exactly_its_job" {
  assert {
    condition     = local.books_allowed == toset(["s3:PutObject", "s3:GetObject", "s3:ListBucket", "kms:GenerateDataKey", "kms:Decrypt", "secretsmanager:GetSecretValue"])
    error_message = "books-monthly may be granted exactly s3:PutObject, s3:GetObject, s3:ListBucket, (through S3) kms:GenerateDataKey + kms:Decrypt, and secretsmanager:GetSecretValue."
  }
}

check "books_role_trusts_one_exact_subject" {
  assert {
    condition = alltrue([
      length(local.trust_statements) == 1,
      !strcontains(jsonencode(local.trust_statements), "StringLike"),
      try(local.trust_statements[0].Condition.StringEquals["${local.github_oidc_host}:sub"], "") == local.github_subject,
      try(local.trust_statements[0].Condition.StringEquals["${local.github_oidc_host}:aud"], "") == "sts.amazonaws.com",
      # GitHub's immutable form (owner@id/name@id). The name-only form is a subject no token from the
      # books repository presents (oidc.tf), so trusting it is a role nothing can assume.
      can(regex("^repo:[A-Za-z0-9_.-]+@[1-9][0-9]*/[A-Za-z0-9_.-]+@[1-9][0-9]*:environment:[A-Za-z0-9._-]+$", local.github_subject)),
    ])
    error_message = "books-monthly must trust exactly ${local.github_subject} (and aud sts.amazonaws.com), with StringEquals and no StringLike, in GitHub's immutable form repo:<owner>@<owner_id>/<name>@<repo_id>:environment:<env>."
  }
}

# ── The bucket ───────────────────────────────────────────────────────────────────────────────────
check "object_lock_is_compliance_4018_days" {
  assert {
    condition = alltrue([
      aws_s3_bucket.archive.object_lock_enabled,
      aws_s3_bucket_object_lock_configuration.archive.rule[0].default_retention[0].mode == "COMPLIANCE",
      aws_s3_bucket_object_lock_configuration.archive.rule[0].default_retention[0].days == 4018,
    ])
    error_message = "the archive must be created with Object Lock, default retention COMPLIANCE for 4018 days (11 years)."
  }
}

check "nothing_ever_expires" {
  assert {
    condition = alltrue([
      length(aws_s3_bucket_lifecycle_configuration.archive.rule) == 1,
      alltrue([
        for r in aws_s3_bucket_lifecycle_configuration.archive.rule :
        length(r.expiration) == 0 && length(r.noncurrent_version_expiration) == 0 && length(r.transition) == 0 && length(r.noncurrent_version_transition) == 0
      ]),
    ])
    error_message = "the archive's lifecycle must be the single abort-incomplete-multipart rule: no expiration, no noncurrent expiration, no transition."
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
    error_message = "kms.tf and bucket.tf must each carry prevent_destroy = true: a destroyed key makes every locked record unreadable."
  }
}

# ── Built names match the real ones ──────────────────────────────────────────────────────────────
check "built_arns_match_the_created_ones" {
  assert {
    condition = alltrue([
      aws_iam_user.writer.arn == local.writer_user_arn,
      aws_iam_role.books.arn == local.books_role_arn,
    ])
    error_message = "a policy names a principal by a BUILT ARN that differs from the one IAM created; the bucket policy would deny that principal everything."
  }
}
