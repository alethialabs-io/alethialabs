# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "admin_role_arn" {
  description = "The role ../ assumes for every apply. Verify with: AWS_PROFILE=alethia-sso aws sts assume-role --role-arn <this> --role-session-name probe --query AssumedRoleUser.Arn"
  value       = aws_iam_role.admin.arn
}

output "backup_account_id" {
  description = "The account the provider actually operated in (read back, not echoed from the variable)."
  value       = data.aws_caller_identity.current.account_id
}
