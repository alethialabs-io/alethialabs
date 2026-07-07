# Alethia Alibaba connector — keyless + account-free (AssumeRoleWithOIDC).
# Alethia's control plane is its own OIDC issuer; this module registers, in YOUR Alibaba
# account, a RAM OIDC provider that trusts that issuer + a RAM role that trusts the provider.
# Alethia assumes the role by presenting a short-lived minted assertion — no Alibaba account
# on Alethia's side, no AccessKey, nothing stored but the two ARNs. Paste the role ARN back
# into the connect sheet (the OIDC-provider ARN is derived from it — the provider is named
# "alethia", fixed, so the console can reconstruct it).
#
# Usage:
#   terraform init && terraform apply -var "region=cn-hangzhou"
#   terraform output            # role_arn / oidc_provider_arn

terraform {
  required_providers {
    alicloud = {
      source  = "aliyun/alicloud"
      version = ">= 1.230"
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }
}

provider "alicloud" {
  region = var.region
  # Auth via ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY (or aliyun CLI profile) — only to CREATE
  # these resources. Alethia never receives these credentials.
}

variable "region" {
  type        = string
  default     = "cn-hangzhou"
  description = "The Alibaba Cloud region to create the RAM resources in (RAM is global; region is for the provider)."
}

variable "alethia_issuer_url" {
  type        = string
  default     = "https://alethialabs.io/api/oidc"
  description = "The Alethia control-plane OIDC issuer URL (the trust root)."
}

variable "role_name" {
  type        = string
  default     = "AlethiaProvisioner"
  description = "Name of the RAM role Alethia assumes to provision infrastructure."
}

# The system RAM policies granted to the provisioning role. Defaults cover the services Alethia
# Projects create (ACK, VPC, ECS, SLB, EIP); tighten or extend to match your Projects.
variable "provisioning_policies" {
  type = list(string)
  default = [
    "AliyunCSFullAccess",
    "AliyunVPCFullAccess",
    "AliyunECSFullAccess",
    "AliyunSLBFullAccess",
    "AliyunEIPFullAccess",
  ]
  description = "System RAM policy names attached to the provisioning role."
}

# The issuer's TLS cert chain — Alibaba requires the issuer cert fingerprints on the OIDC provider.
# We supply every fingerprint in the presented chain so validation succeeds regardless of which
# cert Alibaba pins.
data "tls_certificate" "issuer" {
  url = var.alethia_issuer_url
}

resource "alicloud_ims_oidc_provider" "alethia" {
  oidc_provider_name = "alethia"
  issuer_url         = var.alethia_issuer_url
  client_ids         = ["sts.aliyuncs.com"]
  fingerprints       = [for c in data.tls_certificate.issuer.certificates : c.sha1_fingerprint]
  description        = "Trust the Alethia control-plane OIDC issuer for keyless AssumeRoleWithOIDC."
}

resource "alicloud_ram_role" "alethia" {
  role_name   = var.role_name
  description = "Role Alethia assumes via AssumeRoleWithOIDC to provision infrastructure. Keyless — no stored credentials."

  # Trust only Alethia's OIDC provider, and only the fixed workload subject + audience the console
  # mints (sub "alethia-connector", aud "sts.aliyuncs.com") — a wrong sub/aud is rejected.
  assume_role_policy_document = jsonencode({
    Version = "1"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { OIDC = [alicloud_ims_oidc_provider.alethia.arn] }
      Condition = {
        StringEquals = {
          "oidc:iss" = var.alethia_issuer_url
          "oidc:aud" = "sts.aliyuncs.com"
          "oidc:sub" = "alethia-connector"
        }
      }
    }]
  })

  max_session_duration = 3600
}

resource "alicloud_ram_role_policy_attachment" "provision" {
  for_each    = toset(var.provisioning_policies)
  role_name   = alicloud_ram_role.alethia.id
  policy_name = each.value
  policy_type = "System"
}

output "role_arn" {
  value       = alicloud_ram_role.alethia.arn
  description = "Paste this into the Alethia connect sheet as the RAM Role ARN."
}

output "oidc_provider_arn" {
  value       = alicloud_ims_oidc_provider.alethia.arn
  description = "The RAM OIDC provider ARN (Alethia derives this from the role ARN; shown for reference)."
}
