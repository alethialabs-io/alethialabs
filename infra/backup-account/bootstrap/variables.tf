# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "backup_account_id" {
  description = "The dedicated `alethia-backup` member account. The provider assumes OrganizationAccountAccessRole in it and refuses (allowed_account_ids) to touch any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.backup_account_id))
    error_message = "backup_account_id must be a 12-digit AWS account id."
  }
}

variable "alethia_account_id" {
  description = "The Alethia platform account (prod state, vault, deploy roles). The ONLY account whose principals the backup admin role may trust. Must differ from backup_account_id."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.alethia_account_id))
    error_message = "alethia_account_id must be a 12-digit AWS account id."
  }
}

variable "backup_region" {
  description = "Region for the provider. IAM is global, so this only decides which STS endpoint is used."
  type        = string
  default     = "eu-central-1"
}

variable "management_profile" {
  description = <<-EOT
    The LOCAL AWS CLI profile (a name in ~/.aws/config) whose credentials belong to the
    organization's management account. Only that account can assume OrganizationAccountAccessRole
    in a member it created, so this bootstrap is the one apply that needs it; every later apply of
    ../ goes through the role this creates instead. No default and never committed: it names
    another organization's local configuration. Pass it as TF_VAR_management_profile.
  EOT
  type        = string

  validation {
    condition     = length(trimspace(var.management_profile)) > 0
    error_message = "management_profile must name a local AWS CLI profile for the organization's management account."
  }
}

variable "admin_principal_arns" {
  description = <<-EOT
    The exact IAM role/user ARNs in alethia_account_id allowed to assume `alethia-backup-admin` —
    for the maintainer's SSO session, the AWSReservedSSO_* role ARN as `aws iam list-roles
    --path-prefix /aws-reserved/` prints it, PATH INCLUDED. Matched with ArnEquals on
    aws:PrincipalArn. At least one; no wildcards.
  EOT
  type        = list(string)

  validation {
    condition = length(var.admin_principal_arns) > 0 && alltrue([
      for a in var.admin_principal_arns :
      !strcontains(a, "*") && !strcontains(a, "?") && can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/", a))
    ])
    error_message = "admin_principal_arns must be a non-empty list of concrete arn:aws:iam::<account>:role/... or :user/... ARNs with no wildcard."
  }
}

variable "admin_role_name" {
  description = "Name of the admin role the main backup-account stack assumes for every apply. ../variables.tf `backup_admin_role_name` must match it."
  type        = string
  default     = "alethia-backup-admin"
}

variable "admin_max_session_seconds" {
  description = "Max session for the admin role. One hour covers a plan + apply of ../ with margin."
  type        = number
  default     = 3600
}
