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

# The system RAM policies granted to the provisioning role — one per Alibaba service Alethia's
# project templates create (never account admin / AliyunRAMFullAccess). A given Project uses a
# subset; the role is the union. If you only run a narrower set of Projects, trim this list.
variable "provisioning_policies" {
  type = list(string)
  default = [
    # Core ACK + networking path.
    "AliyunCSFullAccess",  # ACK managed clusters + node pools
    "AliyunVPCFullAccess", # VPC, vSwitch, NAT, SNAT
    "AliyunECSFullAccess", # ECS (consumed transitively by ACK node pools)
    "AliyunSLBFullAccess", # SLB (ACK API-server LB + LoadBalancer Services)
    "AliyunEIPFullAccess", # Elastic IP
    # Optional modules — each attached so the corresponding Project feature can provision.
    "AliyunRDSFullAccess",               # RDS
    "AliyunContainerRegistryFullAccess", # CR Enterprise Edition
    "AliyunKvstoreFullAccess",           # KVStore (Redis)
    "AliyunDNSFullAccess",               # AliDNS
    "AliyunKMSFullAccess",               # KMS
    "AliyunMNSFullAccess",               # Message Service (MNS)
    "AliyunOSSFullAccess",               # OSS
    "AliyunOTSFullAccess",               # Tablestore (OTS)
    "AliyunYundunWAFFullAccess",         # WAF v3
  ]
  description = "System RAM policy names attached to the provisioning role (one per provisioned service)."
}

# The issuer's TLS cert chain — Alibaba pins the issuer cert fingerprints on the OIDC provider. We pin
# only the CA certs (intermediate + root, via the `is_ca` filter — order-independent), NOT the leaf:
# alethialabs.io is fronted by a Cloudflare tunnel whose LEAF cert rotates frequently, so a leaf-pinned
# provider would silently stop validating after a rotation, whereas the issuing CA is stable. When the CA
# itself rotates, re-apply this stack (or re-run alethia-alibaba-setup.sh) to refresh the fingerprints.
data "tls_certificate" "issuer" {
  url = var.alethia_issuer_url
}

locals {
  # Prefer the CA fingerprints; fall back to the whole chain if none is flagged is_ca (defensive).
  issuer_ca_fingerprints = [for c in data.tls_certificate.issuer.certificates : c.sha1_fingerprint if c.is_ca]
  issuer_fingerprints = length(local.issuer_ca_fingerprints) > 0 ? local.issuer_ca_fingerprints : [
    for c in data.tls_certificate.issuer.certificates : c.sha1_fingerprint
  ]
}

resource "alicloud_ims_oidc_provider" "alethia" {
  oidc_provider_name = "alethia"
  issuer_url         = var.alethia_issuer_url
  client_ids         = ["sts.aliyuncs.com"]
  fingerprints       = local.issuer_fingerprints
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

# ACK (and NAT) require the caller to create service-linked roles on first use in an account.
# Grant ONLY ram:CreateServiceLinkedRole (+ delete for teardown) — NOT AliyunRAMFullAccess, which
# would let the role attach arbitrary policies to any principal (full escalation). Service-linked
# roles are cloud-managed with fixed, per-service permissions, so this grant is non-escalating.
resource "alicloud_ram_policy" "service_linked_roles" {
  policy_name     = "${var.role_name}-ServiceLinkedRoles"
  policy_document = <<-JSON
    {
      "Version": "1",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "ram:CreateServiceLinkedRole",
            "ram:DeleteServiceLinkedRole",
            "ram:GetServiceLinkedRoleDeletionStatus"
          ],
          "Resource": "*"
        }
      ]
    }
  JSON
  description     = "Narrow: only service-linked-role creation for ACK/NAT — no policy-attach escalation."
}

resource "alicloud_ram_role_policy_attachment" "service_linked_roles" {
  role_name   = alicloud_ram_role.alethia.id
  policy_name = alicloud_ram_policy.service_linked_roles.policy_name
  policy_type = "Custom"
}

output "role_arn" {
  value       = alicloud_ram_role.alethia.arn
  description = "Paste this into the Alethia connect sheet as the RAM Role ARN."
}

output "oidc_provider_arn" {
  value       = alicloud_ims_oidc_provider.alethia.arn
  description = "The RAM OIDC provider ARN (Alethia derives this from the role ARN; shown for reference)."
}
