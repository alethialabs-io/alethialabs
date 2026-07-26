# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "Region the canary secret lives in. Must match the region the e2e passes as ALETHIA_E2E_SECRETS_XACCT_REGION — ESO reads the secret through the store's `region`, so a mismatch is a ResourceNotFound at sync time."
  type        = string
  default     = "us-east-1"
}

variable "cluster_account_id" {
  description = "Account A — the account the e2e provisions its EKS cluster in. Its external-secrets IRSA role is the only principal allowed to assume the read role created here."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.cluster_account_id))
    error_message = "cluster_account_id must be a 12-digit AWS account id."
  }
}

variable "cluster_eso_role_pattern" {
  description = <<-EOT
    IAM path pattern matching the e2e cluster's external-secrets IRSA role name, used as an
    `ArnLike` condition on `aws:PrincipalArn` in the read role's trust policy.

    A pattern is required rather than an exact ARN because the e2e cluster is EPHEMERAL. IAM
    resolves a role-ARN principal to that role's unique id (AROA...) when the trust policy is
    SAVED, and a destroy/recreate mints a new unique id — so an exact-ARN trust is dead on the
    second run. `aws:PrincipalArn` is evaluated per REQUEST against the caller's current ARN, which
    survives recreation.

    This is an E2E-ONLY divergence from the shipped customer bootstrap
    (infra/connector/aws/secrets-xacct), which trusts an exact ARN and must stay that way. The
    checks below keep this pattern narrow: it is still one role name shape in one account, never a
    wildcard over the account's roles.
  EOT
  type        = string
  default     = "eks-*-secrets-operator"
}

variable "secret_name" {
  description = "Name of the canary secret the e2e reads across the account boundary."
  type        = string
  default     = "alethia-e2e/xacct-canary"
}

variable "canary_value" {
  description = "Value of the canary secret. The e2e compares only its sha256, so this never appears in CI config, logs or the proof bundle. No default — supply it at apply time (TF_VAR_canary_value) so it is never committed."
  type        = string
  sensitive   = true
}

variable "external_id" {
  description = "OPTIONAL sts:ExternalId the read role's trust policy requires. Empty (default) means no ExternalId condition — matching the connector's optional external_id field."
  type        = string
  default     = ""
  sensitive   = true
}

variable "role_name" {
  description = "Name of the cross-account read role. Becomes the connector's target_role_arn."
  type        = string
  default     = "AlethiaE2ESecretsReadRole"
}

variable "tags" {
  description = "Tags applied to every taggable resource."
  type        = map(string)
  default = {
    ManagedBy = "alethia"
    Purpose   = "e2e-xacct-secrets"
  }
}
