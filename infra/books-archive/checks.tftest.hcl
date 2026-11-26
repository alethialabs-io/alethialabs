# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The posture test for infra/books-archive: proof that the committed terraform.tfvars plans the
# protections the design promises, and that the refusals and checks FIRE — a guard nobody has seen
# fail is indistinguishable from no guard.
#
# Plan-only and credential-free, the same harness as infra/backup-account/checks.tftest.hcl. The
# provider block below REPLACES the stack's (no assume_role, no allowed_account_ids, so nothing calls
# STS), and the two data sources that would call AWS are overridden. The provider is the REAL one,
# not a mock: aws_iam_policy_document renders locally, and a mocked one returns random JSON — every
# policy assertion below would then be about noise.
#
#   cd infra/books-archive && tofu init -backend=false && tofu test
# Run in CI by .github/workflows/infra-books-archive.yml.

provider "aws" {
  region                      = "eu-central-1"
  access_key                  = "mock"
  secret_key                  = "mock"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "450956683176"
  }
}

override_data {
  target = data.aws_iam_openid_connect_provider.github
  values = {
    arn = "arn:aws:iam::450956683176:oidc-provider/token.actions.githubusercontent.com"
  }
}

# Computed ARNs, as AWS builds them from the names. A plan cannot know them, and `tofu test` fails a
# run whose check is unknown.
override_resource {
  target = aws_kms_key.archive
  values = {
    id     = "00000000-0000-0000-0000-000000000000"
    key_id = "00000000-0000-0000-0000-000000000000"
    arn    = "arn:aws:kms:eu-central-1:450956683176:key/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target = aws_iam_user.writer
  values = {
    arn = "arn:aws:iam::450956683176:user/alethia-books/console-books-writer"
  }
}

override_resource {
  target = aws_iam_role.books
  values = {
    arn = "arn:aws:iam::450956683176:role/books-monthly"
  }
}

override_resource {
  target = aws_secretsmanager_secret.connectors
  values = {
    arn = "arn:aws:secretsmanager:eu-central-1:450956683176:secret:alethia/books/connectors-AbCdEf"
  }
}

variables {
  # Never committed.
  console_writer_source_cidrs = ["203.0.113.10/32", "2001:db8::10/128"]
  budget_alert_emails         = ["ops@example.com"]
}

# ── The committed posture ────────────────────────────────────────────────────────────────────────

run "committed_posture_plans_the_immutable_archive" {
  command = plan

  # The bucket: Object Lock COMPLIANCE 4018 days, versioning, encryption, ownership, public access.
  assert {
    condition     = aws_s3_bucket.archive.bucket == "alethia-books-archive-450956683176" && aws_s3_bucket.archive.object_lock_enabled && !aws_s3_bucket.archive.force_destroy
    error_message = "the bucket must be alethia-books-archive-<account>, created WITH Object Lock, never force-destroyed."
  }
  assert {
    condition     = aws_s3_bucket_object_lock_configuration.archive.rule[0].default_retention[0].mode == "COMPLIANCE" && aws_s3_bucket_object_lock_configuration.archive.rule[0].default_retention[0].days == 4018 && aws_s3_bucket_object_lock_configuration.archive.rule[0].default_retention[0].years == null
    error_message = "default retention must be COMPLIANCE, 4018 days (11 years), stated in days only."
  }
  assert {
    condition     = aws_s3_bucket_versioning.archive.versioning_configuration[0].status == "Enabled"
    error_message = "versioning must be on (Object Lock requires it)."
  }
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.archive.rule :
      r.bucket_key_enabled && one(r.apply_server_side_encryption_by_default).sse_algorithm == "aws:kms" && one(r.apply_server_side_encryption_by_default).kms_master_key_id == "arn:aws:kms:eu-central-1:450956683176:key/00000000-0000-0000-0000-000000000000"
    ])
    error_message = "the bucket must default to SSE-KMS under the stack's key, with a Bucket Key."
  }
  assert {
    condition     = aws_s3_bucket_ownership_controls.archive.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "object ownership must be BucketOwnerEnforced (ACLs disabled)."
  }
  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.archive.block_public_acls,
      aws_s3_bucket_public_access_block.archive.block_public_policy,
      aws_s3_bucket_public_access_block.archive.ignore_public_acls,
      aws_s3_bucket_public_access_block.archive.restrict_public_buckets,
    ])
    error_message = "all four public-access blocks must be on."
  }

  # Lifecycle: one rule, abort only, nothing expires.
  assert {
    condition = (
      length(aws_s3_bucket_lifecycle_configuration.archive.rule) == 1 &&
      one(aws_s3_bucket_lifecycle_configuration.archive.rule).status == "Enabled" &&
      one(one(aws_s3_bucket_lifecycle_configuration.archive.rule).abort_incomplete_multipart_upload).days_after_initiation == 1 &&
      length(one(aws_s3_bucket_lifecycle_configuration.archive.rule).expiration) == 0 &&
      length(one(aws_s3_bucket_lifecycle_configuration.archive.rule).noncurrent_version_expiration) == 0 &&
      length(one(aws_s3_bucket_lifecycle_configuration.archive.rule).transition) == 0
    )
    error_message = "the only lifecycle rule must abort incomplete multipart uploads after 1 day, and nothing may expire or transition."
  }

  # KMS.
  assert {
    condition     = aws_kms_key.archive.deletion_window_in_days == 30 && aws_kms_key.archive.enable_key_rotation
    error_message = "the key must rotate and keep the maximum 30-day deletion window."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_kms_key.archive.policy).Statement : s
      if s.Effect == "Deny"
      && toset(flatten([s.Action])) == toset(["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy"])
      && toset(flatten([s.Condition.ArnNotLike["aws:PrincipalArn"]])) == toset([
        "arn:aws:iam::450956683176:role/alethia-backup-admin",
        "arn:aws:iam::450956683176:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*",
      ])
    ]) == 1
    error_message = "the key policy must deny ScheduleKeyDeletion, DisableKey and PutKeyPolicy to every principal but alethia-backup-admin and the Identity Center admins."
  }

  # The bucket policy.
  assert {
    condition     = strcontains(aws_s3_bucket_policy.archive.policy, "aws:SecureTransport") && strcontains(aws_s3_bucket_policy.archive.policy, "DenyInsecureTransport")
    error_message = "the bucket policy must refuse plain HTTP."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.archive.policy).Statement : s
      if s.Effect == "Deny"
      && length(setsubtract(toset(["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention", "s3:PutBucketObjectLockConfiguration", "s3:PutLifecycleConfiguration", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration", "s3:PutBucketPolicy", "s3:DeleteBucketPolicy", "s3:DeleteBucket"]), toset(flatten([s.Action])))) == 0
      && toset(flatten([s.Condition.ArnNotLike["aws:PrincipalArn"]])) == toset([
        "arn:aws:iam::450956683176:role/alethia-backup-admin",
        "arn:aws:iam::450956683176:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*",
      ])
    ]) == 1
    error_message = "the bucket policy must deny delete, retention, legal-hold, governance bypass and bucket-configuration changes to everyone but the admins."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_s3_bucket_policy.archive.policy).Statement : s
      if s.Effect == "Deny" && flatten([s.Action]) == ["s3:*"]
      && toset(flatten([try(s.Condition.ArnNotLike["aws:PrincipalArn"], [])])) == toset([
        "arn:aws:iam::450956683176:role/alethia-backup-admin",
        "arn:aws:iam::450956683176:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*",
        "arn:aws:iam::450956683176:role/books-monthly",
        "arn:aws:iam::450956683176:user/alethia-books/console-books-writer",
      ])
    ]) == 1
    error_message = "the bucket must answer only the admins, books-monthly and console-books-writer."
  }
  assert {
    condition     = !strcontains(aws_s3_bucket_policy.archive.policy, "OrganizationAccountAccessRole") && !strcontains(aws_s3_bucket_policy.archive.policy, "270587882865") && !strcontains(aws_s3_bucket_policy.archive.policy, "backup-writer")
    error_message = "the bucket policy must name nothing in the platform account, not the management account's role, and none of the backup stack's identities."
  }

  # No principal this stack creates holds a delete, a retention change or the governance bypass.
  assert {
    condition = length([
      for a in flatten([
        for p in [aws_iam_role_policy.books.policy, aws_iam_user_policy.writer.policy] : [
          for s in jsondecode(p).Statement : flatten([s.Action]) if s.Effect == "Allow"
        ]
      ]) : a
      if startswith(a, "s3:Delete") || a == "s3:PutObjectRetention" || a == "s3:BypassGovernanceRetention" || a == "s3:PutObjectLegalHold" || strcontains(a, "*")
    ]) == 0
    error_message = "no principal may be granted s3:Delete*, s3:PutObjectRetention, s3:PutObjectLegalHold, s3:BypassGovernanceRetention or a wildcard."
  }

  # books-monthly: trust.
  assert {
    condition = (
      length(jsondecode(aws_iam_role.books.assume_role_policy).Statement) == 1 &&
      jsondecode(aws_iam_role.books.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:alethialabs-io@293964056/books@1470091729:environment:books" &&
      jsondecode(aws_iam_role.books.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com" &&
      jsondecode(aws_iam_role.books.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::450956683176:oidc-provider/token.actions.githubusercontent.com" &&
      !strcontains(aws_iam_role.books.assume_role_policy, "StringLike") &&
      !strcontains(aws_iam_role.books.assume_role_policy, "alethialabs-io/alethialabs")
    )
    error_message = "books-monthly must trust exactly repo:alethialabs-io@293964056/books@1470091729:environment:books (GitHub's immutable subject) through the account's existing GitHub OIDC provider, with StringEquals."
  }

  # books-monthly: grants.
  assert {
    condition = (
      flatten([for s in jsondecode(aws_iam_role_policy.books.policy).Statement : s.Resource if s.Effect == "Allow" && flatten([s.Action]) == ["s3:PutObject"]]) == ["arn:aws:s3:::alethia-books-archive-450956683176/records/*"] &&
      toset(flatten([for s in jsondecode(aws_iam_role_policy.books.policy).Statement : s.Resource if s.Effect == "Allow" && flatten([s.Action]) == ["s3:GetObject"]])) == toset(["arn:aws:s3:::alethia-books-archive-450956683176/inbound/*", "arn:aws:s3:::alethia-books-archive-450956683176/records/*"]) &&
      flatten([for s in jsondecode(aws_iam_role_policy.books.policy).Statement : s.Resource if s.Effect == "Allow" && flatten([s.Action]) == ["secretsmanager:GetSecretValue"]]) == ["arn:aws:secretsmanager:eu-central-1:450956683176:secret:alethia/books/connectors-??????"]
    )
    error_message = "books-monthly may put under records/ only, get under inbound/ and records/ only, and read only alethia/books/connectors."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.books.policy).Statement :
      try(s.Condition.StringEquals["kms:ViaService"], "") == "s3.eu-central-1.amazonaws.com" && try(s.Condition["ForAnyValue:StringEquals"]["kms:ResourceAliases"], "") == "alias/alethia-books-archive"
      if anytrue([for a in flatten([s.Action]) : startswith(a, "kms:")])
    ])
    error_message = "books-monthly's KMS rights must be on the archive key only, and only through S3."
  }

  # console-books-writer.
  assert {
    condition     = aws_iam_user.writer.name == "console-books-writer" && aws_iam_user.writer.path == "/alethia-books/"
    error_message = "the writer must be console-books-writer under /alethia-books/."
  }
  assert {
    condition = (
      toset(flatten([for s in jsondecode(aws_iam_user_policy.writer.policy).Statement : s.Action if s.Effect == "Allow"])) == toset(["s3:PutObject", "kms:GenerateDataKey", "kms:Decrypt"]) &&
      flatten([for s in jsondecode(aws_iam_user_policy.writer.policy).Statement : s.Resource if s.Effect == "Allow" && flatten([s.Action]) == ["s3:PutObject"]]) == ["arn:aws:s3:::alethia-books-archive-450956683176/inbound/console/*"]
    )
    error_message = "console-books-writer may hold only s3:PutObject on inbound/console/* plus the two KMS actions S3 needs."
  }
  assert {
    condition = (
      length([
        for s in jsondecode(aws_iam_user_policy.writer.policy).Statement : s
        if s.Effect == "Allow" && flatten([s.Action]) == ["s3:PutObject"]
        && toset(flatten([s.Condition.IpAddress["aws:SourceIp"]])) == toset(["203.0.113.10/32", "2001:db8::10/128"])
      ]) == 1 &&
      length([
        for s in jsondecode(aws_iam_user_policy.writer.policy).Statement : s
        if s.Effect == "Deny"
        && toset(flatten([s.Condition.NotIpAddress["aws:SourceIp"]])) == toset(["203.0.113.10/32", "2001:db8::10/128"])
        && s.Condition.Bool["aws:ViaAWSService"] == "false"
      ]) == 1
    )
    error_message = "console-books-writer's PutObject must carry the aws:SourceIp condition with the box's addresses, and a Deny must refuse everything from elsewhere."
  }

  # The connectors secret: a shell, readable only by books-monthly and the admins.
  assert {
    condition     = aws_secretsmanager_secret.connectors.name == "alethia/books/connectors" && aws_secretsmanager_secret.connectors.recovery_window_in_days == 30
    error_message = "the connectors secret must be alethia/books/connectors with a 30-day recovery window."
  }
  assert {
    condition     = strcontains(aws_secretsmanager_secret_policy.connectors.policy, "role/books-monthly") && strcontains(aws_secretsmanager_secret_policy.connectors.policy, "ArnNotLike")
    error_message = "the connectors secret's policy must refuse GetSecretValue to everyone but books-monthly and the admins."
  }
  assert {
    condition = length([
      for s in jsondecode(aws_secretsmanager_secret_policy.connectors.policy).Statement : s
      if s.Effect == "Deny"
      && length(setsubtract(toset(["secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret", "secretsmanager:PutResourcePolicy"]), toset(flatten([s.Action])))) == 0
      && !strcontains(jsonencode(s), "books-monthly")
    ]) == 1
    error_message = "only the admins (not books-monthly, not anyone else) may replace the connectors value, delete the secret or change its policy."
  }

  # The budget.
  assert {
    condition     = aws_budgets_budget.archive.limit_amount == "5" && aws_budgets_budget.archive.limit_unit == "USD"
    error_message = "the committed budget is USD 5 a month."
  }
  assert {
    condition     = contains(flatten([for f in aws_budgets_budget.archive.cost_filter : f.values if f.name == "TagKeyValue"]), "user:role$books-archive")
    error_message = "the budget must be scoped to this stack's resources by the user:role$books-archive cost allocation tag."
  }
}

# ── No credential resource, and the source scan is reading the stack ────────────────────────────

run "no_access_key_or_secret_version_resource" {
  command = plan

  assert {
    condition = alltrue([
      length(regexall(local.access_key_resource_re, local.stack_source)) == 0,
      length(regexall(local.secret_value_re, local.stack_source)) == 0,
      strcontains(local.stack_source, "resource \"aws_iam_user\" \"writer\""),
      strcontains(local.stack_source, "resource \"aws_secretsmanager_secret\" \"connectors\""),
    ])
    error_message = "the stack must declare no aws_iam_access_key (or other credential) and no aws_secretsmanager_secret_version — and the scan must be reading the stack (it sees the writer and the secret shell)."
  }
}

# The patterns match what they claim to refuse. (checks.tf cannot be fed a planted file, so this
# proves the patterns; the run above proves the stack is clean of them.)
run "the_source_patterns_match_their_targets" {
  command = plan

  assert {
    condition = alltrue([
      length(regexall(local.access_key_resource_re, "resource \"aws_iam_access_key\" \"writer\" {")) == 1,
      length(regexall(local.access_key_resource_re, "resource  \"aws_iam_user_login_profile\" \"x\" {")) == 1,
      length(regexall(local.access_key_resource_re, "resource \"aws_iam_service_specific_credential\" \"x\" {")) == 1,
      length(regexall(local.secret_value_re, "resource \"aws_secretsmanager_secret_version\" \"v\" {")) == 1,
      length(regexall(local.secret_value_re, "resource \"aws_secretsmanager_secret\" \"connectors\" {")) == 0,
      length(regexall(local.prevent_destroy_re, "    prevent_destroy = true")) == 1,
      length(regexall(local.prevent_destroy_re, "    prevent_destroy = false")) == 0,
    ])
    error_message = "a source pattern in checks.tf no longer matches the construct it exists to refuse."
  }
}

# ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

run "the_platform_account_as_the_archive_account_is_refused" {
  command = plan
  variables {
    backup_account_id = "270587882865"
  }

  expect_failures = [
    aws_kms_key.archive,
    aws_s3_bucket.archive,
    aws_iam_user.writer,
    aws_iam_role.books,
    aws_secretsmanager_secret.connectors,
    check.archive_account_is_the_backup_one,
  ]
}

run "no_writer_address_is_refused" {
  command = plan
  variables {
    console_writer_source_cidrs = []
  }

  expect_failures = [var.console_writer_source_cidrs]
}

run "a_whole_internet_writer_address_is_refused" {
  command = plan
  variables {
    console_writer_source_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.console_writer_source_cidrs]
}

run "no_budget_recipient_is_refused" {
  command = plan
  variables {
    budget_alert_emails = []
  }

  expect_failures = [var.budget_alert_emails]
}

run "a_wildcard_environment_is_refused" {
  command = plan
  variables {
    books_github_environment = "*"
  }

  expect_failures = [var.books_github_environment]
}

run "a_non_numeric_repo_id_is_refused" {
  command = plan
  variables {
    books_github_repo_id = "*"
  }

  expect_failures = [var.books_github_repo_id]
}

# ── Each check that reads a live value can fire ──────────────────────────────────────────────────

run "the_wrong_account_fires_the_account_check" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "444455556666"
    }
  }

  expect_failures = [check.archive_account_is_the_backup_one]
}

run "a_drifted_role_arn_fires_the_built_arn_check" {
  command = plan

  override_resource {
    target = aws_iam_role.books
    values = {
      arn = "arn:aws:iam::450956683176:role/some-path/books-monthly"
    }
  }

  expect_failures = [check.built_arns_match_the_created_ones]
}
