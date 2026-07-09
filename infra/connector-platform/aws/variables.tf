# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "Region the provider operates in (IAM is global; used for the provider + STS)."
  type        = string
  default     = "eu-central-1"
}

variable "platform_account_id" {
  description = "The platform AWS account this identity must live in (the account customer trust policies name). A check block fails the apply if the caller is in a different account."
  type        = string
  default     = "270587882865"
}

variable "role_name" {
  description = "Name of the platform IAM role the console federates into (keyless, via the OIDC issuer) to assume customer roles."
  type        = string
  default     = "alethia-connector-assumer"
}

variable "oidc_issuer_url" {
  description = "The Alethia control-plane OIDC issuer URL (the web-identity trust root). Must be publicly reachable (AWS fetches its JWKS)."
  type        = string
  default     = "https://alethialabs.io/api/oidc"
}

variable "oidc_audience" {
  description = "The audience the console mints into the web-identity token (the OIDC provider client id)."
  type        = string
  default     = "sts.amazonaws.com"
}

variable "workload_subject" {
  description = "The fixed OIDC subject the console mints (WORKLOAD_SUBJECT in lib/oidc/issuer.ts). The role trusts only this subject."
  type        = string
  default     = "alethia-connector"
}

variable "customer_role_name_prefix" {
  description = "Name prefix of the customer cross-account provisioner role (AlethiaProvisionerRole-<externalId>, from infra/connector/aws/alethia-bootstrap.yaml). The assumer may assume ONLY roles matching this prefix."
  type        = string
  default     = "AlethiaProvisionerRole-"
}
