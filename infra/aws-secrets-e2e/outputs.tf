# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# These become the repo VARIABLES the nightly passes to the e2e (not secrets: a role ARN, an
# account id, a region, a secret name and a hash are all non-sensitive). See
# docs/testing/e2e-nightly-enablement.md.

output "target_role_arn" {
  description = "ALETHIA_E2E_SECRETS_XACCT_ROLE_ARN — the connector's target_role_arn."
  value       = aws_iam_role.read.arn
}

output "target_account_id" {
  description = "ALETHIA_E2E_SECRETS_XACCT_ACCOUNT — the connector's target_account_id."
  value       = data.aws_caller_identity.current.account_id
}

output "region" {
  description = "ALETHIA_E2E_SECRETS_XACCT_REGION — the region the canary lives in."
  value       = var.aws_region
}

output "secret_name" {
  description = "ALETHIA_E2E_SECRETS_XACCT_REMOTE_KEY — the remoteRef key the ExternalSecret reads."
  value       = aws_secretsmanager_secret.canary.name
}

output "canary_sha256" {
  description = "ALETHIA_E2E_SECRETS_XACCT_EXPECT_SHA256 — sha256 of the canary value. The e2e compares this, so the value itself never enters CI config, logs or the proof bundle."
  # nonsensitive() is deliberate and is the whole design: the hash inherits canary_value's sensitive
  # mark, but publishing the DIGEST instead of the value is precisely what keeps the secret out of
  # repo variables, job logs and the proof bundle. A SHA-256 of a high-entropy random value is not
  # reversible — terraform.tfvars.example therefore generates it with `openssl rand`, and a
  # low-entropy canary_value would invalidate this reasoning.
  value = nonsensitive(sha256(var.canary_value))
}
