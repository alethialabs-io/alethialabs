# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The weekly automated restore drill's AWS side (design §A.3 "Restore test", decision A-4). The
# workflow that launches it and the script it runs are BKP-L3; this file is everything they need to
# exist first:
#
#   network        one VPC, one subnet, an internet gateway for EGRESS (GitHub, the image registry,
#                  S3). The security group has NO ingress rule: nothing can connect to the instance.
#   restore-drill  the instance role: read the backups, read the drill's age identity, write evidence/
#   launch tmpl    spot, IMDSv2 only, encrypted disk, no key pair, terminate on power-off, and a
#                  user-data whose first act is to schedule its own power-off (the lifetime limit)
#   secret         the SHELL that holds the drill's age identity. The value is put in by the
#                  maintainer (README step 5); this stack never writes one, so it never reaches state.
#
# The trade-off decision A-4 accepted: an admin of THIS account holds both the ciphertext and the
# drill's key to it. The primary and break-glass identities stay offline, which is what keeps a
# recovery possible if this account is ever lost.

locals {
  # Canonical's public SSM parameter for the current Ubuntu 24.04 LTS AMI. The launch template names
  # the PARAMETER (`resolve:ssm:`), so every drill boots a patched image without a plan diff, and
  # Ubuntu ships docker compose v2 and age as packages.
  drill_ami_parameter = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"

  drill_secret_name = "alethia/backup/drill-age-identity"
  drill_vpc_cidr    = "10.73.0.0/24"
}

# ── Network: egress only ─────────────────────────────────────────────────────────────────────────

resource "aws_vpc" "drill" {
  cidr_block           = local.drill_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "alethia-restore-drill" }
}

# The VPC's default security group, emptied: nothing launched without naming a group gets any rule.
resource "aws_default_security_group" "drill" {
  vpc_id = aws_vpc.drill.id
}

resource "aws_internet_gateway" "drill" {
  vpc_id = aws_vpc.drill.id
  tags   = { Name = "alethia-restore-drill" }
}

# No map_public_ip_on_launch: the one public address comes from the launch template's network
# interface, so only the drill instance gets one.
resource "aws_subnet" "drill" {
  vpc_id            = aws_vpc.drill.id
  cidr_block        = local.drill_vpc_cidr
  availability_zone = "${var.backup_region}a"
  tags              = { Name = "alethia-restore-drill" }
}

resource "aws_route_table" "drill" {
  vpc_id = aws_vpc.drill.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.drill.id
  }

  tags = { Name = "alethia-restore-drill" }
}

resource "aws_route_table_association" "drill" {
  subnet_id      = aws_subnet.drill.id
  route_table_id = aws_route_table.drill.id
}

# No ingress rule at all. Egress is open because the drill pulls container images and clones the
# repository from large, moving address ranges (the same accepted posture as infra/cp-aws,
# AVD-AWS-0104 in infra/.trivyignore). The restored stack itself runs on a compose network with no
# egress (scripts/ops/restore-drill.sh).
resource "aws_security_group" "drill" {
  name        = "alethia-restore-drill"
  description = "Restore drill instance: no ingress, egress for image pulls, git and S3."
  vpc_id      = aws_vpc.drill.id

  # Explicitly empty (not omitted), so an ingress rule added by hand is removed by the next apply.
  ingress = []

  egress {
    description = "HTTPS and HTTP out (registry, GitHub, S3, apt)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ── The instance role ────────────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "drill_trust" {
  statement {
    sid     = "Ec2"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.backup_account_id]
    }
  }
}

resource "aws_iam_role" "drill" {
  name                 = local.drill_role_name
  description          = "Restore drill instance: reads the backups and the drill age identity, writes evidence/. Created by infra/backup-account."
  assume_role_policy   = data.aws_iam_policy_document.drill_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "drill" {
  statement {
    sid       = "ReadBackups"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${local.bucket_arn}/${var.backup_prefix}/*"]
  }

  statement {
    sid       = "ListBackups"
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
    sid       = "WriteEvidence"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${local.bucket_arn}/${local.evidence_prefix}*"]
  }

  statement {
    sid       = "ReadTheDrillIdentity"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.drill_secret_arn_pattern]
  }

  statement {
    sid       = "UseTheKeyThroughS3AndSecretsManagerOnly"
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
      values   = [local.s3_via_service, local.secrets_via_service]
    }
  }

  statement {
    sid       = "EncryptEvidenceThroughS3Only"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey"]
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

resource "aws_iam_role_policy" "drill" {
  name   = "alethia-backup-restore-drill"
  role   = aws_iam_role.drill.id
  policy = data.aws_iam_policy_document.drill.json
}

resource "aws_iam_instance_profile" "drill" {
  name = local.drill_role_name
  role = aws_iam_role.drill.name
}

# A new account has no Spot service-linked role, and RunInstances with spot options fails without
# one unless the CALLER may create it. Creating it here keeps iam:CreateServiceLinkedRole out of
# drill-launcher's policy.
resource "aws_iam_service_linked_role" "spot" {
  aws_service_name = "spot.amazonaws.com"
}

# ── The launch template ──────────────────────────────────────────────────────────────────────────

resource "aws_launch_template" "drill" {
  name                   = "alethia-restore-drill"
  description            = "Weekly restore drill. Launched only by drill-launcher (restore-drill.yml), with nothing overridden."
  image_id               = "resolve:ssm:${local.drill_ami_parameter}"
  instance_type          = var.drill_instance_type
  update_default_version = true

  # Powering off TERMINATES. The user-data schedules a power-off at boot, so the instance cannot
  # outlive drill_max_lifetime_minutes even if the drill hangs.
  instance_initiated_shutdown_behavior = "terminate"

  iam_instance_profile {
    arn = aws_iam_instance_profile.drill.arn
  }

  instance_market_options {
    market_type = "spot"
    spot_options {
      spot_instance_type             = "one-time"
      instance_interruption_behavior = "terminate"
    }
  }

  # IMDSv2 only. Hop limit 2, not 1: the drill runs rclone in a container (deploy/prod/backup/lib.sh
  # BACKUP_RCLONE_IMAGE), and a bridged container is one hop further from the metadata service.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "disabled"
  }

  network_interfaces {
    device_index                = 0
    subnet_id                   = aws_subnet.drill.id
    security_groups             = [aws_security_group.drill.id]
    associate_public_ip_address = true
    delete_on_termination       = true
  }

  # Room for the decrypted dump, the bucket copy and the images. Encrypted, gone with the instance.
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_size           = 60
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/drill-user-data.sh.tftpl", {
    max_lifetime_minutes = var.drill_max_lifetime_minutes
    region               = var.backup_region
    s3_endpoint          = local.s3_endpoint
    bucket               = local.bucket_name
    backup_prefix        = var.backup_prefix
    evidence_prefix      = local.evidence_prefix
    secret_name          = local.drill_secret_name
    github_repo          = var.github_repo
    github_branch        = var.github_branch
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.drill_tag, { Name = "alethia-restore-drill" })
  }

  tag_specifications {
    resource_type = "volume"
    tags          = local.drill_tag
  }

  tag_specifications {
    resource_type = "spot-instances-request"
    tags          = local.drill_tag
  }

  depends_on = [aws_iam_service_linked_role.spot]
}

# ── The drill's age identity: a shell, never a value ─────────────────────────────────────────────

resource "aws_secretsmanager_secret" "drill_identity" {
  name                    = local.drill_secret_name
  description             = "The restore drill's age identity (private key). Value put in by the maintainer, never by tofu. Readable only by the restore-drill instance role."
  kms_key_id              = aws_kms_key.backup.arn
  recovery_window_in_days = 30
}

data "aws_iam_policy_document" "drill_identity" {
  # Only the drill instance role may READ it. Admins may still put a new value or change this policy,
  # which is how the maintainer fills and rotates it.
  statement {
    sid       = "OnlyTheDrillReadsIt"
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [local.drill_role_arn]
    }
  }
}

resource "aws_secretsmanager_secret_policy" "drill_identity" {
  secret_arn = aws_secretsmanager_secret.drill_identity.arn
  policy     = data.aws_iam_policy_document.drill_identity.json
}
