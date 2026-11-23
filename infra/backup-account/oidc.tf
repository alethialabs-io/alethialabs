# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The two identities GitHub Actions assumes in the backup account, through the account's own GitHub
# OIDC provider (an IAM OIDC provider is per-account; a new member account has none). No thumbprint
# list: optional from provider 5.81, as infra/aws-e2e/oidc.tf.
#
#   backup-reader   the daily freshness monitor (BKP-L2, backup-status.yml). Reads the pointer, the
#                   manifests and the tombstone pointer — never a data file — and nothing else.
#   drill-launcher  the weekly restore drill (BKP-L3, restore-drill.yml). Starts ONE instance, from
#                   the ONE launch template in drill.tf, with nothing overridden; reads the drill's
#                   evidence back; can terminate only an instance that carries the drill's tag.
#
# Both trust exactly one subject: repo:<github_repo>:ref:refs/heads/<github_branch> (main). A
# `schedule` run and a `workflow_dispatch` from main both present it; a run from any other branch,
# a pull request or a fork does not.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"
  # Built from plan-time values so the trust documents render on the first plan;
  # check.github_oidc_provider_arn_matches compares it with the real ARN.
  github_oidc_provider_arn = "arn:aws:iam::${var.backup_account_id}:oidc-provider/${local.github_oidc_host}"
  github_subject           = "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}"

  # Named once so checks.tf can read the run policy's actions while its condition is still unknown.
  launcher_run_actions = ["ec2:RunInstances"]
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_trust" {
  statement {
    sid     = "GitHubActionsOneBranch"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [local.github_subject]
    }
  }
}

# ── backup-reader ────────────────────────────────────────────────────────────────────────────────

resource "aws_iam_role" "reader" {
  name                 = local.reader_role_name
  description          = "Off-box backup freshness monitor (backup-status.yml): reads latest.json, manifests and the tombstone pointer. Created by infra/backup-account."
  assume_role_policy   = data.aws_iam_policy_document.github_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "reader" {
  # What `backup.sh status` reads (deploy/prod/backup/backup.sh cmd_status): latest.json, the
  # manifest of the daily it names, and tombstones/latest.json. Manifests of weeklies too, so the
  # monitor can report on them later without a policy change. No *.age file matches any of these.
  statement {
    sid     = "ReadPointersAndManifests"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "${local.bucket_arn}/${var.backup_prefix}/latest.json",
      "${local.bucket_arn}/${var.backup_prefix}/tombstones/latest.json",
      "${local.bucket_arn}/${local.daily_prefix}*/manifest.json",
      "${local.bucket_arn}/${local.weekly_prefix}*/manifest.json",
    ]
  }

  statement {
    sid       = "ListBackupPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [var.backup_prefix, "${var.backup_prefix}/*"]
    }
  }

  statement {
    sid       = "DecryptThroughS3Only"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [local.kms_key_arn_pattern]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.kms_alias_name]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.s3_via_service]
    }
  }
}

resource "aws_iam_role_policy" "reader" {
  name   = "alethia-backup-read-pointers"
  role   = aws_iam_role.reader.id
  policy = data.aws_iam_policy_document.reader.json
}

# ── drill-launcher ───────────────────────────────────────────────────────────────────────────────

resource "aws_iam_role" "launcher" {
  name                 = local.launcher_role_name
  description          = "Weekly restore drill (restore-drill.yml): launches the one drill launch template and reads its evidence. Created by infra/backup-account."
  assume_role_policy   = data.aws_iam_policy_document.github_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "launcher" {
  # The template's tag specifications are applied by RunInstances itself.
  statement {
    sid     = "TagOnlyAtLaunch"
    effect  = "Allow"
    actions = ["ec2:CreateTags"]
    resources = [
      "arn:aws:ec2:${var.backup_region}:${var.backup_account_id}:instance/*",
      "arn:aws:ec2:${var.backup_region}:${var.backup_account_id}:volume/*",
      "arn:aws:ec2:${var.backup_region}:${var.backup_account_id}:network-interface/*",
      "arn:aws:ec2:${var.backup_region}:${var.backup_account_id}:spot-instances-request/*",
    ]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }

  # The template's image is `resolve:ssm:<public parameter>`; EC2 resolves it with the CALLER's
  # permission to read that one parameter.
  statement {
    sid       = "ResolveTheDrillImage"
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.backup_region}::parameter${local.drill_ami_parameter}"]
  }

  statement {
    sid       = "PassOnlyTheDrillRoleToEc2"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [local.drill_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  # Read-only and account-wide by AWS's design (Describe* takes no resource ARN).
  statement {
    sid       = "WatchTheDrill"
    effect    = "Allow"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"]
    resources = ["*"]
  }

  # A backstop for the instance's own lifetime limit: the workflow can end a drill that overran.
  # Only an instance carrying the drill's tag, which only the launch template applies.
  statement {
    sid       = "TerminateOnlyDrillInstances"
    effect    = "Allow"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.backup_region}:${var.backup_account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/alethia-role"
      values   = [local.drill_tag["alethia-role"]]
    }
  }

  statement {
    sid       = "ReadDrillEvidence"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${local.bucket_arn}/${local.evidence_prefix}*"]
  }

  statement {
    sid       = "ListDrillEvidence"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [local.evidence_prefix, "${local.evidence_prefix}*"]
    }
  }

  statement {
    sid       = "DecryptEvidenceThroughS3Only"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [local.kms_key_arn_pattern]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.kms_alias_name]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.s3_via_service]
    }
  }
}

resource "aws_iam_role_policy" "launcher" {
  name   = "alethia-backup-launch-drill"
  role   = aws_iam_role.launcher.id
  policy = data.aws_iam_policy_document.launcher.json
}

# RunInstances only from THIS launch template, and only with every resource taken from it
# (ec2:IsLaunchTemplateResource): the caller cannot swap the AMI, the instance profile, the network,
# the user-data or the shutdown behaviour. The resource is "*" because RunInstances authorises every
# resource type it touches (instance, volume, ENI, subnet, SG, image); the two conditions are what
# scope it.
#
# Except the spot request. AWS's Service Authorization Reference lists only aws:RequestTag and
# aws:TagKeys for the spot-instances-request resource of RunInstances — neither ec2:LaunchTemplate nor
# ec2:IsLaunchTemplateResource is in its request context, so the first statement can never match it
# (the first drill failed exactly there). It gets its own statement, on that one resource type and
# without a condition. That adds no launch the first statement does not already permit: RunInstances
# authorises every resource of a call together, so a spot request is only ever created alongside an
# instance, volume and ENI that each still have to come from this template. RequestSpotInstances,
# the other way to create one, is not granted.
#
# A policy of its own, built with jsonencode, because the template's ARN carries an id known only
# after apply: in the policy document above it would defer the WHOLE document to apply time, so the
# first plan — and checks.tf — could not read any of the launcher's other grants.
resource "aws_iam_role_policy" "launcher_run" {
  name = "alethia-backup-run-drill-template"
  role = aws_iam_role.launcher.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RunOnlyTheDrillLaunchTemplate"
        Effect   = "Allow"
        Action   = local.launcher_run_actions
        Resource = "*"
        Condition = {
          ArnEquals = { "ec2:LaunchTemplate" = aws_launch_template.drill.arn }
          Bool      = { "ec2:IsLaunchTemplateResource" = "true" }
        }
      },
      {
        Sid      = "TheDrillsSpotRequest"
        Effect   = "Allow"
        Action   = local.launcher_run_actions
        Resource = "arn:aws:ec2:${var.backup_region}:${var.backup_account_id}:spot-instances-request/*"
      },
    ]
  })
}
