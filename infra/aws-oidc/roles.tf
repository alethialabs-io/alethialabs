# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

# ── Control-plane / status deploy role ───────────────────────────────────────
# cp-hetzner + status touch AWS ONLY for OpenTofu state (Hetzner + Cloudflare use
# their own API tokens). So this role's entire footprint is S3 access to the two
# state prefixes — nothing else.
resource "aws_iam_role" "cp_deployer" {
  name               = "alethia-cp-deployer"
  description        = "Least-priv OIDC role for infra/cp-hetzner + infra/status - S3 state only."
  assume_role_policy = data.aws_iam_policy_document.deployer_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "cp_deployer" {
  statement {
    sid       = "TofuStateBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketVersioning"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}"]
    # Restrict listing to just the two prefixes this role owns.
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["hetzner/*", "status/*"]
    }
  }
  statement {
    sid    = "TofuStateObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "arn:aws:s3:::${var.state_bucket_name}/hetzner/*",
      "arn:aws:s3:::${var.state_bucket_name}/status/*",
    ]
  }
  # Read TF-var inputs (hcloud/cloudflare/ssh) from the vault, and write the
  # provisioned TUNNEL_TOKEN + DEPLOY_HOST back into it. Scoped to the one secret.
  statement {
    sid    = "AsmReadWrite"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [aws_secretsmanager_secret.prod_env.arn]
  }
}

resource "aws_iam_role_policy" "cp_deployer" {
  name   = "alethia-cp-deploy"
  role   = aws_iam_role.cp_deployer.id
  policy = data.aws_iam_policy_document.cp_deployer.json
}

# ── Runner-release deploy role ───────────────────────────────────────────────
# release-runner + deploy-fleet-aws: push the runner image to one ECR repo and roll
# one ECS service. Scoped to exactly that repo + service.
resource "aws_iam_role" "runner_release_deployer" {
  name               = "alethia-runner-release-deployer"
  description        = "Least-priv OIDC role for release-runner + deploy-fleet-aws - ECR push + ECS roll."
  assume_role_policy = data.aws_iam_policy_document.deployer_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "runner_release_deployer" {
  # ECR auth token is account-wide (no resource-level scoping possible).
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  # Push/pull layers + images to the single runner repo.
  statement {
    sid    = "EcrPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = ["arn:aws:ecr:${var.runner_aws_region}:${local.account_id}:repository/${var.runner_ecr_repository}"]
  }
  # Force a new deployment on the single runner service.
  statement {
    sid    = "EcsRoll"
    effect = "Allow"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = ["arn:aws:ecs:${var.runner_aws_region}:${local.account_id}:service/${var.runner_ecs_cluster}/${var.runner_ecs_service}"]
  }
  # Read RELEASE_API_SECRET from the vault to POST release metadata to the console.
  statement {
    sid       = "AsmRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.prod_env.arn]
  }
}

resource "aws_iam_role_policy" "runner_release_deployer" {
  name   = "alethia-runner-release-deploy"
  role   = aws_iam_role.runner_release_deployer.id
  policy = data.aws_iam_policy_document.runner_release_deployer.json
}

# ── Deploy-console read-only vault role ──────────────────────────────────────
# deploy-console fetches the prod secret to assemble .env on the box. Read-only on
# the one secret — nothing else (no state, no ECR/ECS).
resource "aws_iam_role" "deploy_reader" {
  name               = "alethia-deploy-reader"
  description        = "Least-priv OIDC role for deploy-console - read the prod secret only."
  assume_role_policy = data.aws_iam_policy_document.deployer_trust.json
  tags               = local.tags
}

data "aws_iam_policy_document" "deploy_reader" {
  statement {
    sid       = "AsmRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.prod_env.arn]
  }
}

resource "aws_iam_role_policy" "deploy_reader" {
  name   = "alethia-deploy-read"
  role   = aws_iam_role.deploy_reader.id
  policy = data.aws_iam_policy_document.deploy_reader.json
}
