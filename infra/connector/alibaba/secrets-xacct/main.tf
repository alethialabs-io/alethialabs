# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Cross-account keyless Alibaba KMS Secrets Manager — TARGET-account trust bootstrap (Model B).
#
# You run this in the RAM account that OWNS the secrets (account B), ONCE. It registers your cluster's
# ACK OIDC issuer as a RAM OIDC provider in account B and creates a least-privilege KMS-read role that
# trusts it — no access key is created or stored. The in-cluster External Secrets Operator's RRSA
# identity exchanges its projected OIDC token DIRECTLY for this target role (ESO does a single
# AssumeRoleWithOIDC — no role chaining — so the token must be exchangeable in the target account, which
# is why the OIDC provider must live here). Enter the printed role ARN + OIDC provider ARN in the Alethia
# `alibaba-kms-xacct` connector.
#
# Prereqs: OpenTofu/Terraform authenticated to the SECRETS account (B); the cluster's ACK OIDC issuer URL
# (the project's `rrsa_oidc_issuer_url` output).

variable "cluster_oidc_issuer_url" {
  description = "The Alethia cluster's ACK RRSA OIDC issuer URL (account A) — the project's rrsa_oidc_issuer_url output. This account (B) will register it as a RAM OIDC provider and trust it."
  type        = string
}

variable "role_name" {
  description = "Name of the KMS-read role to create in the secrets account."
  type        = string
  default     = "AlethiaSecretsReadRole"
}

variable "oidc_provider_name" {
  description = "Name of the RAM OIDC provider to register in the secrets account for the cluster's ACK issuer."
  type        = string
  default     = "alethia-cluster-rrsa"
}

variable "external_secrets_sa_subject" {
  description = "The RRSA token subject the target role trusts — the external-secrets operator ServiceAccount. Default matches the seams-rendered store."
  type        = string
  default     = "system:serviceaccount:external-secrets-operator:external-secrets-operator-sa"
}

variable "kms_secret_resources" {
  description = "KMS Secrets Manager resource ARNs the cluster may read. Default '*' allows any secret in this account — SCOPE THIS to the specific secrets you share (least-privilege)."
  type        = list(string)
  default     = ["*"]
}

# The cluster ACK issuer's TLS CA fingerprints — Alibaba pins them on the OIDC provider. Pin the CA
# (stable), not the leaf, mirroring the Alethia connector bootstrap.
data "tls_certificate" "issuer" {
  url = var.cluster_oidc_issuer_url
}

locals {
  issuer_ca_fingerprints = [for c in data.tls_certificate.issuer.certificates : c.sha1_fingerprint if c.is_ca]
  issuer_fingerprints = length(local.issuer_ca_fingerprints) > 0 ? local.issuer_ca_fingerprints : [
    for c in data.tls_certificate.issuer.certificates : c.sha1_fingerprint
  ]
}

# Register the cluster's ACK issuer as a RAM OIDC provider in THIS (secrets) account.
resource "alicloud_ims_oidc_provider" "cluster" {
  oidc_provider_name = var.oidc_provider_name
  issuer_url         = var.cluster_oidc_issuer_url
  client_ids         = ["sts.aliyuncs.com"]
  fingerprints       = local.issuer_fingerprints
  description        = "Trust the Alethia cluster's ACK RRSA issuer for keyless cross-account KMS read."
}

# A KMS-read role trusting ONLY the cluster's external-secrets ServiceAccount via that provider — a wrong
# subject / audience / issuer is rejected.
resource "alicloud_ram_role" "read" {
  role_name   = var.role_name
  description = "Least-privilege KMS Secrets Manager read role assumed by the Alethia cluster's external-secrets operator (cross-account keyless RRSA)."

  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { OIDC = [alicloud_ims_oidc_provider.cluster.arn] }
      Condition = {
        StringEquals = {
          "oidc:iss" = var.cluster_oidc_issuer_url
          "oidc:aud" = "sts.aliyuncs.com"
          "oidc:sub" = var.external_secrets_sa_subject
        }
      }
    }]
  })

  max_session_duration = 3600
}

# Read ONLY — GetSecretValue + DescribeSecret. No write, no delete.
resource "alicloud_ram_policy" "read" {
  policy_name = "${var.role_name}-SecretsRead"
  policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:GetSecretValue", "kms:DescribeSecret"]
      Resource = var.kms_secret_resources
    }]
  })
  description = "Least-privilege KMS Secrets Manager read for the Alethia cluster's external-secrets operator."
}

resource "alicloud_ram_role_policy_attachment" "read" {
  role_name   = alicloud_ram_role.read.id
  policy_name = alicloud_ram_policy.read.policy_name
  policy_type = "Custom"
}

output "target_role_arn" {
  value       = alicloud_ram_role.read.arn
  description = "Copy this into the Alethia alibaba-kms-xacct connector's Target Role ARN."
}

output "target_oidc_provider_arn" {
  value       = alicloud_ims_oidc_provider.cluster.arn
  description = "Copy this into the Alethia alibaba-kms-xacct connector's Target OIDC Provider ARN."
}
