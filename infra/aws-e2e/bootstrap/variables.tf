# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "e2e_account_id" {
  description = "The dedicated `alethia-e2e` member account. The provider assumes OrganizationAccountAccessRole in it and refuses (allowed_account_ids) to touch any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.e2e_account_id))
    error_message = "e2e_account_id must be a 12-digit AWS account id."
  }
}

variable "alethia_account_id" {
  description = "The Alethia platform account (prod state, vault, ECR, SES). The ONLY account whose principals the e2e admin role may trust. Must differ from e2e_account_id."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.alethia_account_id))
    error_message = "alethia_account_id must be a 12-digit AWS account id."
  }
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
    The exact IAM role/user ARNs in alethia_account_id allowed to assume `alethia-e2e-admin` —
    for the maintainer's SSO session, the AWSReservedSSO_* role ARN as `aws iam list-roles
    --path-prefix /aws-reserved/` prints it, PATH INCLUDED. Matched with ArnEquals on
    aws:PrincipalArn, so a re-provisioned permission set (new role id, same ARN) keeps working and
    no other principal in the account matches. At least one; no wildcards.
  EOT
  type        = list(string)

  validation {
    # The account half (every ARN is in alethia_account_id) is a precondition on the role in
    # main.tf: it reads a second variable, which a validation block cannot portably do.
    condition = length(var.admin_principal_arns) > 0 && alltrue([
      for a in var.admin_principal_arns :
      !strcontains(a, "*") && !strcontains(a, "?") && can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/", a))
    ])
    error_message = "admin_principal_arns must be a non-empty list of concrete arn:aws:iam::<account>:role/... or :user/... ARNs with no wildcard."
  }
}

variable "admin_role_name" {
  description = "Name of the admin role the main aws-e2e stack assumes for every apply. ../variables.tf `e2e_admin_role_name` must match it."
  type        = string
  default     = "alethia-e2e-admin"
}

variable "admin_max_session_seconds" {
  description = "Max session for the admin role. One hour covers a plan + apply of ../ with margin."
  type        = number
  default     = 3600
}
