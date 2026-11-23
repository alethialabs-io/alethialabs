# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The posture test for infra/backup-account: proof that the committed terraform.tfvars plans the
# protections the design promises, and that the refusals and checks FIRE — a guard nobody has seen
# fail is indistinguishable from no guard.
#
# Plan-only and credential-free, the same harness as infra/email-ses-account/checks.tftest.hcl. The
# provider block below REPLACES the stack's (no assume_role, no allowed_account_ids, so nothing calls
# STS), and the one data source that would call AWS is overridden. The provider is the REAL one, not
# a mock: aws_iam_policy_document renders locally, and a mocked one returns random JSON — every
# policy assertion below would then be about noise.
#
#   cd infra/backup-account && tofu init -backend=false && tofu test
# Run in CI by .github/workflows/infra-backup-account.yml.
#
# What a plan cannot show — which resource TYPES exist, and prevent_destroy — is read from the
# stack's source by checks.tf (no_credential_or_secret_value_resource,
# key_and_bucket_cannot_be_destroyed_by_tofu). Every run below that is not an expected failure fails
# if any check fails, so those hold on every run; the last two runs prove their patterns match.

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
    account_id = "111122223333"
  }
}

# Computed ARNs, as AWS builds them from the names. A plan cannot know them, and `tofu test` fails a
# run whose check is unknown.
override_resource {
  target = aws_kms_key.backup
  values = {
    id     = "00000000-0000-0000-0000-000000000000"
    key_id = "00000000-0000-0000-0000-000000000000"
    arn    = "arn:aws:kms:eu-central-1:111122223333:key/00000000-0000-0000-0000-000000000000"
  }
}

override_resource {
  target = aws_iam_openid_connect_provider.github
  values = {
    arn = "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com"
  }
}

override_resource {
  target = aws_iam_user.writer
  values = {
    arn = "arn:aws:iam::111122223333:user/alethia-backup/backup-writer"
  }
}

override_resource {
  target = aws_iam_role.reader
  values = {
    arn = "arn:aws:iam::111122223333:role/backup-reader"
  }
}

override_resource {
  target = aws_iam_role.launcher
  values = {
    arn = "arn:aws:iam::111122223333:role/drill-launcher"
  }
}

override_resource {
  target = aws_iam_role.drill
  values = {
    arn = "arn:aws:iam::111122223333:role/restore-drill"
  }
}

override_resource {
  target = aws_launch_template.drill
  values = {
    id  = "lt-0123456789abcdef0"
    arn = "arn:aws:ec2:eu-central-1:111122223333:launch-template/lt-0123456789abcdef0"
  }
}

override_resource {
  target = aws_secretsmanager_secret.drill_identity
  values = {
    arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:alethia/backup/drill-age-identity-AbCdEf"
  }
}

variables {
  # Not committed: the account does not exist yet, and the other two must never be.
  backup_account_id   = "111122223333"
  writer_source_cidrs = ["203.0.113.10/32", "2001:db8::10/128"]
  budget_alert_emails = ["ops@example.com"]
}

# ── The committed posture ────────────────────────────────────────────────────────────────────────

run "committed_posture_plans_the_protected_store" {
  command = plan

  # Object Lock, versioning, encryption, public access.
  assert {
    condition     = aws_s3_bucket.backup.bucket == "alethia-prod-backup-111122223333" && aws_s3_bucket.backup.object_lock_enabled && !aws_s3_bucket.backup.force_destroy
    error_message = "the bucket must be alethia-prod-backup-<account>, created WITH Object Lock, never force-destroyed."
  }
  assert {
    condition     = aws_s3_bucket_object_lock_configuration.backup.rule[0].default_retention[0].mode == "COMPLIANCE" && aws_s3_bucket_object_lock_configuration.backup.rule[0].default_retention[0].days == 15
    error_message = "default retention must be COMPLIANCE, 15 days (decision A-2)."
  }
  assert {
    condition     = aws_s3_bucket_versioning.backup.versioning_configuration[0].status == "Enabled"
    error_message = "versioning must be on (Object Lock requires it)."
  }
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.backup.rule :
      r.bucket_key_enabled && one(r.apply_server_side_encryption_by_default).sse_algorithm == "aws:kms" && one(r.apply_server_side_encryption_by_default).kms_master_key_id == "arn:aws:kms:eu-central-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    ])
    error_message = "the bucket must default to SSE-KMS under the stack's key, with a Bucket Key."
  }
  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.backup.block_public_acls,
      aws_s3_bucket_public_access_block.backup.block_public_policy,
      aws_s3_bucket_public_access_block.backup.ignore_public_acls,
      aws_s3_bucket_public_access_block.backup.restrict_public_buckets,
    ])
    error_message = "all four public-access blocks must be on."
  }

  # KMS.
  assert {
    condition     = aws_kms_key.backup.deletion_window_in_days == 30 && aws_kms_key.backup.enable_key_rotation
    error_message = "the key must rotate and keep the maximum 30-day deletion window."
  }

  # Lifecycle: daily 15 d, weekly 60 d, noncurrent 16 d.
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_lifecycle_configuration.backup.rule :
      one(r.expiration).days == 15 if r.id == "daily-copies"
    ]) && contains([for r in aws_s3_bucket_lifecycle_configuration.backup.rule : one(r.filter).prefix if r.id == "daily-copies"], "alethia-prod/daily/")
    error_message = "daily copies (alethia-prod/daily/) must expire after 15 days."
  }
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_lifecycle_configuration.backup.rule :
      one(r.expiration).days == 60 if r.id == "weekly-copies"
    ]) && contains([for r in aws_s3_bucket_lifecycle_configuration.backup.rule : one(r.filter).prefix if r.id == "weekly-copies"], "alethia-prod/weekly/")
    error_message = "weekly copies (alethia-prod/weekly/) must expire after 60 days."
  }
  assert {
    condition = contains([
      for r in aws_s3_bucket_lifecycle_configuration.backup.rule :
      one(r.noncurrent_version_expiration).noncurrent_days if r.id == "noncurrent-and-housekeeping"
    ], 16)
    error_message = "noncurrent versions must be removed 16 days after they stop being current."
  }

  # The bucket policy.
  assert {
    condition     = strcontains(aws_s3_bucket_policy.backup.policy, "aws:SecureTransport") && strcontains(aws_s3_bucket_policy.backup.policy, "DenyInsecureTransport")
    error_message = "the bucket policy must refuse plain HTTP."
  }
  assert {
    condition     = !strcontains(aws_s3_bucket_policy.backup.policy, "OrganizationAccountAccessRole") && strcontains(aws_s3_bucket_policy.backup.policy, "AWSReservedSSO_AdministratorAccess_*") && strcontains(aws_s3_bucket_policy.backup.policy, "role/alethia-backup-admin")
    error_message = "the bucket's admins are the apply role and the Identity Center AdministratorAccess roles — not the management account's role."
  }
  assert {
    condition     = !strcontains(aws_s3_bucket_policy.backup.policy, "270587882865")
    error_message = "the bucket policy must name nothing in the Alethia platform account."
  }

  # The writer.
  assert {
    condition     = aws_iam_user.writer.name == "backup-writer" && aws_iam_user.writer.path == "/alethia-backup/"
    error_message = "the writer must be backup-writer under /alethia-backup/."
  }
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_user_policy.writer.policy).Statement : s.Action if s.Effect == "Allow"
    ])) == toset(["s3:PutObject", "s3:GetObject", "s3:ListBucket", "kms:GenerateDataKey", "kms:Decrypt"])
    error_message = "backup-writer may be granted exactly Put/Get/List and the two KMS actions S3 needs."
  }
  assert {
    condition     = !strcontains(lower(aws_iam_user_policy.writer.policy), "delete") && !strcontains(aws_iam_user_policy.writer.policy, "PutObjectRetention") && !strcontains(aws_iam_user_policy.writer.policy, "\"s3:*\"")
    error_message = "backup-writer must hold no delete, no retention change and no wildcard."
  }
  assert {
    condition     = strcontains(aws_iam_user_policy.writer.policy, "203.0.113.10/32") && strcontains(aws_iam_user_policy.writer.policy, "2001:db8::10/128") && strcontains(aws_iam_user_policy.writer.policy, "aws:ViaAWSService")
    error_message = "backup-writer must be locked to the box's addresses, with a Deny for everywhere else."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_user_policy.writer.policy).Statement :
      alltrue([for r in flatten([s.Resource]) : r == "*" || startswith(r, "arn:aws:s3:::alethia-prod-backup-111122223333") || startswith(r, "arn:aws:kms:")])
      if s.Effect == "Allow"
    ])
    error_message = "backup-writer's grants must name only this bucket and the stack's key."
  }

  # Multipart uploads (backup.sh bucket mode, BKP-L1): S3 calls KMS GenerateDataKey for each part
  # and Decrypt to complete the upload, both on the writer's behalf. Scoped to this key (by alias),
  # this account and region, and to calls made through S3.
  assert {
    condition = length([
      for s in jsondecode(aws_iam_user_policy.writer.policy).Statement : s
      if s.Effect == "Allow"
      && toset(flatten([s.Action])) == toset(["kms:GenerateDataKey", "kms:Decrypt"])
      && try(s.Condition.StringEquals["kms:ViaService"], "") == "s3.eu-central-1.amazonaws.com"
      && try(s.Condition["ForAnyValue:StringEquals"]["kms:ResourceAliases"], "") == "alias/alethia-prod-backup"
      && flatten([s.Resource]) == ["arn:aws:kms:eu-central-1:111122223333:key/*"]
    ]) == 1
    error_message = "backup-writer must hold kms:GenerateDataKey + kms:Decrypt on the backup key only (alias-scoped, this account and region), and only through S3: multipart uploads need both."
  }
  assert {
    condition     = !strcontains(aws_iam_user_policy.writer.policy, "s3:AbortMultipartUpload")
    error_message = "backup-writer must not hold s3:AbortMultipartUpload; the bucket's lifecycle aborts abandoned uploads instead."
  }
  # The writer cannot abort, so the bucket does: an upload left incomplete is aborted after a day.
  assert {
    condition = contains([
      for r in aws_s3_bucket_lifecycle_configuration.backup.rule :
      one(r.abort_incomplete_multipart_upload).days_after_initiation
      if r.status == "Enabled" && length(r.abort_incomplete_multipart_upload) == 1
    ], 1)
    error_message = "the bucket must abort incomplete multipart uploads 1 day after initiation (the writer has no AbortMultipartUpload)."
  }
  assert {
    condition     = output.backup_env.BACKUP_S3_SSE_KMS_KEY_ID == "arn:aws:kms:eu-central-1:111122223333:key/00000000-0000-0000-0000-000000000000"
    error_message = "backup_env must carry the backup key's ARN as BACKUP_S3_SSE_KMS_KEY_ID (backup.sh bucket mode needs it)."
  }

  # The OIDC roles.
  assert {
    condition = alltrue([
      for p in [aws_iam_role.reader.assume_role_policy, aws_iam_role.launcher.assume_role_policy] :
      strcontains(p, "repo:alethialabs-io/alethialabs:ref:refs/heads/main") && strcontains(p, "StringEquals") && !strcontains(p, "StringLike")
    ])
    error_message = "both OIDC roles must trust exactly repo:alethialabs-io/alethialabs:ref:refs/heads/main, with StringEquals."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.reader.policy, ".age") && !strcontains(aws_iam_role_policy.reader.policy, "s3:PutObject") && strcontains(aws_iam_role_policy.reader.policy, "alethia-prod/latest.json")
    error_message = "backup-reader may read the pointers and manifests only — no data file, no write."
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.launcher_run.policy, "lt-0123456789abcdef0") && strcontains(aws_iam_role_policy.launcher_run.policy, "ec2:IsLaunchTemplateResource")
    error_message = "drill-launcher may run only the drill launch template, with nothing overridden."
  }
  # The spot request carries no launch-template condition key, so it needs its own statement — and
  # that statement must stay on the spot-request resource type alone, never "*".
  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.launcher_run.policy).Statement) == 2 &&
      length([
        for s in jsondecode(aws_iam_role_policy.launcher_run.policy).Statement : s
        if !can(s.Condition) && s.Resource != "arn:aws:ec2:eu-central-1:111122223333:spot-instances-request/*"
      ]) == 0 &&
      length([
        for s in jsondecode(aws_iam_role_policy.launcher_run.policy).Statement : s
        if s.Resource == "arn:aws:ec2:eu-central-1:111122223333:spot-instances-request/*" && jsonencode(s.Action) == jsonencode(["ec2:RunInstances"])
      ]) == 1
    )
    error_message = "drill-launcher's only unconditioned RunInstances grant must be on spot-instances-request/* (the one RunInstances resource the drill touches without the launch-template keys)."
  }

  # The drill.
  assert {
    condition = (
      aws_launch_template.drill.instance_initiated_shutdown_behavior == "terminate" &&
      aws_launch_template.drill.metadata_options[0].http_tokens == "required" &&
      aws_launch_template.drill.instance_market_options[0].market_type == "spot" &&
      aws_launch_template.drill.block_device_mappings[0].ebs[0].encrypted == "true" &&
      aws_launch_template.drill.key_name == null
    )
    error_message = "the drill template must be spot, IMDSv2-only, encrypted, keyless, and terminate on power-off."
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.drill.user_data), "shutdown -h +240")
    error_message = "the drill's user-data must schedule its own power-off at boot (the lifetime limit)."
  }
  assert {
    condition     = length(aws_security_group.drill.ingress) == 0
    error_message = "the drill's security group must have no ingress rule."
  }
  assert {
    condition     = strcontains(aws_secretsmanager_secret_policy.drill_identity.policy, "role/restore-drill") && strcontains(aws_secretsmanager_secret_policy.drill_identity.policy, "secretsmanager:GetSecretValue")
    error_message = "only the restore-drill role may read the drill identity."
  }

  # The budget.
  assert {
    condition     = aws_budgets_budget.backup.limit_amount == "15" && aws_budgets_budget.backup.limit_unit == "USD"
    error_message = "the committed budget is USD 15 a month."
  }
}

# ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

run "the_platform_account_as_the_backup_account_is_refused" {
  command = plan
  variables {
    backup_account_id = "270587882865"
  }

  expect_failures = [
    aws_kms_key.backup,
    aws_s3_bucket.backup,
    aws_iam_user.writer,
    check.backup_account_is_the_dedicated_one,
  ]
}

run "no_writer_address_is_refused" {
  command = plan
  variables {
    writer_source_cidrs = []
  }

  expect_failures = [var.writer_source_cidrs]
}

run "a_whole_internet_writer_address_is_refused" {
  command = plan
  variables {
    writer_source_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.writer_source_cidrs]
}

run "no_budget_recipient_is_refused" {
  command = plan
  variables {
    budget_alert_emails = []
  }

  expect_failures = [var.budget_alert_emails]
}

run "a_wildcard_branch_is_refused" {
  command = plan
  variables {
    github_branch = "*"
  }

  expect_failures = [var.github_branch]
}

# ── Each check can fire ──────────────────────────────────────────────────────────────────────────

run "the_wrong_account_fires_the_account_check" {
  command = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "444455556666"
    }
  }

  expect_failures = [check.backup_account_is_the_dedicated_one]
}

run "a_drifted_role_arn_fires_the_built_arn_check" {
  command = plan

  override_resource {
    target = aws_iam_role.drill
    values = {
      arn = "arn:aws:iam::111122223333:role/some-path/restore-drill"
    }
  }

  expect_failures = [check.built_arns_match_the_created_ones]
}

# The source-scanning patterns match what they claim to refuse. (checks.tf cannot be fed a planted
# file, so these prove the patterns; the committed runs above prove the stack is clean of them.)
run "the_source_patterns_match_their_targets" {
  command = plan

  assert {
    condition = alltrue([
      length(regexall(local.access_key_resource_re, "resource \"aws_iam_access_key\" \"writer\" {")) == 1,
      length(regexall(local.access_key_resource_re, "resource  \"aws_iam_user_login_profile\" \"x\" {")) == 1,
      length(regexall(local.secret_value_re, "resource \"aws_secretsmanager_secret_version\" \"v\" {")) == 1,
      length(regexall(local.prevent_destroy_re, "    prevent_destroy = true")) == 1,
      length(regexall(local.prevent_destroy_re, "    prevent_destroy = false")) == 0,
    ])
    error_message = "a source pattern in checks.tf no longer matches the construct it exists to refuse."
  }
  assert {
    condition     = length(regexall(local.access_key_resource_re, local.stack_source)) == 0 && strcontains(local.stack_source, "resource \"aws_iam_user\" \"writer\"")
    error_message = "the scanned source must contain the writer user (so the scan is reading the stack) and no access-key resource."
  }
}
