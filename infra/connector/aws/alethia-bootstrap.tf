variable "issuer_url" {
  type        = string
  default     = "https://alethialabs.io/api/oidc"
  description = "The Alethia control-plane OIDC issuer this account trusts. Override only for a self-hosted Alethia."
}

variable "issuer_audience" {
  type        = string
  default     = "sts.amazonaws.com"
  description = "The audience the minted assertion carries (pinned in the trust policy). Do not change."
}

variable "workload_subject" {
  type        = string
  default     = "alethia-connector"
  description = "The fixed workload subject Alethia mints (pinned in the trust policy). Do not change."
}

variable "role_name" {
  type        = string
  default     = "AlethiaProvisionerRole"
  description = "The name of the IAM role to be created."
}

locals {
  # The OIDC condition keys AWS derives from the provider URL (scheme stripped).
  oidc_host = replace(var.issuer_url, "https://", "")
}

# The Alethia issuer as an IAM OIDC identity provider. AWS validates each assertion's signature against the
# issuer's published JWKS; the thumbprint is required by the API but no longer used for a well-known-CA
# issuer, so we derive it from the live TLS chain rather than hand-maintaining it.
data "tls_certificate" "issuer" {
  url = var.issuer_url
}

resource "aws_iam_openid_connect_provider" "alethia" {
  url             = var.issuer_url
  client_id_list  = [var.issuer_audience]
  thumbprint_list = [data.tls_certificate.issuer.certificates[length(data.tls_certificate.issuer.certificates) - 1].sha1_fingerprint]
}

# Trust ONLY Alethia's issuer, pinned to the fixed workload subject + audience the console mints — no
# external id, no trust in an Alethia AWS account. A wrong sub/aud is rejected.
data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.alethia.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = [var.issuer_audience]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = [var.workload_subject]
    }
  }
}

resource "aws_iam_role" "alethia_role" {
  name               = var.role_name
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_iam_role_policy_attachment" "admin_access" {
  role       = aws_iam_role.alethia_role.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "role_arn" {
  value       = aws_iam_role.alethia_role.arn
  description = "The ARN of the created role. Copy this back into the Alethia dashboard."
}
