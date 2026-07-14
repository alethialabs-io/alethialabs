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

# Enumerated least-privilege CUSTOM policies — one per service group, replacing the per-service System
# `*FullAccess` policies. No `service:*` wildcards: each bucket lists the specific create/read/modify/
# delete/tag actions the template's modules issue (reads lean permissive — `Describe*/Get*/List*` — so a
# provider bump doesn't break a real apply). Grouped into 4 buckets, each well under RAM's ~6144-char
# per-policy limit. Every action name was validated via `aliyun ram CreatePolicy` (all accepted). The
# `cs:` (ACK) action names are the least-documented — if a real ACK provision fails, widen that bucket
# first (its Describe*/Get*/List* reads are already permissive).
locals {
  provisioning_custom_policies = {
    # ACK cluster + its transitively-created node-pool ECS + API-server/Service SLB.
    ComputeCluster = [
      "cs:CreateCluster", "cs:DeleteCluster", "cs:ModifyCluster", "cs:ModifyClusterConfiguration",
      "cs:UpgradeCluster", "cs:MigrateCluster", "cs:CreateClusterNodePool", "cs:ModifyClusterNodePool",
      "cs:DeleteClusterNodePool", "cs:ScaleClusterNodePool", "cs:RepairClusterNodePool",
      "cs:AttachInstances", "cs:GrantPermissions", "cs:TagResources", "cs:UntagResources",
      "cs:Describe*", "cs:Get*", "cs:List*", "cs:CheckControlPlaneLogEnable",
      "ecs:RunInstances", "ecs:CreateInstance", "ecs:DeleteInstance", "ecs:DeleteInstances",
      "ecs:StartInstance", "ecs:StopInstance", "ecs:StopInstances", "ecs:ModifyInstanceAttribute",
      "ecs:ModifyInstanceSpec", "ecs:ReplaceSystemDisk", "ecs:CreateSecurityGroup",
      "ecs:DeleteSecurityGroup", "ecs:AuthorizeSecurityGroup", "ecs:AuthorizeSecurityGroupEgress",
      "ecs:RevokeSecurityGroup", "ecs:RevokeSecurityGroupEgress", "ecs:ModifySecurityGroupPolicy",
      "ecs:CreateDisk", "ecs:DeleteDisk", "ecs:AttachDisk", "ecs:DetachDisk", "ecs:ResizeDisk",
      "ecs:CreateNetworkInterface", "ecs:DeleteNetworkInterface", "ecs:AttachNetworkInterface",
      "ecs:DetachNetworkInterface", "ecs:CreateKeyPair", "ecs:ImportKeyPair", "ecs:DeleteKeyPairs",
      "ecs:AttachKeyPair", "ecs:CreateLaunchTemplate", "ecs:CreateLaunchTemplateVersion",
      "ecs:DeleteLaunchTemplate", "ecs:TagResources", "ecs:UntagResources", "ecs:Describe*", "ecs:List*",
      "slb:CreateLoadBalancer", "slb:DeleteLoadBalancer", "slb:ModifyLoadBalancerInstanceSpec",
      "slb:ModifyLoadBalancerInternetSpec", "slb:SetLoadBalancerName", "slb:CreateLoadBalancerTCPListener",
      "slb:CreateLoadBalancerUDPListener", "slb:CreateLoadBalancerHTTPListener",
      "slb:CreateLoadBalancerHTTPSListener", "slb:DeleteLoadBalancerListener",
      "slb:StartLoadBalancerListener", "slb:StopLoadBalancerListener",
      "slb:SetLoadBalancerTCPListenerAttribute", "slb:AddBackendServers", "slb:RemoveBackendServers",
      "slb:SetBackendServers", "slb:AddVServerGroupBackendServers", "slb:CreateVServerGroup",
      "slb:DeleteVServerGroup", "slb:ModifyVServerGroupBackendServers", "slb:TagResources",
      "slb:UntagResources", "slb:Describe*", "slb:List*",
    ]
    # VPC / vSwitch / NAT / SNAT + Elastic IP (both the vpc: and split-out eip: namespaces).
    Network = [
      "vpc:CreateVpc", "vpc:DeleteVpc", "vpc:ModifyVpcAttribute", "vpc:CreateVSwitch",
      "vpc:DeleteVSwitch", "vpc:ModifyVSwitchAttribute", "vpc:CreateNatGateway", "vpc:DeleteNatGateway",
      "vpc:ModifyNatGatewayAttribute", "vpc:CreateSnatEntry", "vpc:DeleteSnatEntry", "vpc:ModifySnatEntry",
      "vpc:CreateRouteEntry", "vpc:DeleteRouteEntry", "vpc:AssociateRouteTable", "vpc:TagResources",
      "vpc:UnTagResources", "vpc:Describe*", "vpc:List*", "vpc:Get*",
      "vpc:AllocateEipAddress", "vpc:ReleaseEipAddress", "vpc:AssociateEipAddress",
      "vpc:UnassociateEipAddress", "vpc:ModifyEipAddressAttribute", "vpc:DescribeEipAddresses",
      "eip:AllocateEipAddress", "eip:ReleaseEipAddress", "eip:AssociateEipAddress",
      "eip:UnassociateEipAddress", "eip:ModifyEipAddressAttribute", "eip:TagResources",
      "eip:UnTagResources", "eip:DescribeEipAddresses", "eip:Describe*", "eip:List*",
    ]
    # RDS + KVStore(Redis) + OSS + Tablestore(OTS) + KMS secrets.
    Data = [
      "rds:CreateDBInstance", "rds:DeleteDBInstance", "rds:ModifyDBInstanceSpec",
      "rds:ModifyDBInstanceConnectionString", "rds:AllocateInstancePublicConnection", "rds:ModifySecurityIps",
      "rds:CreateDatabase", "rds:DeleteDatabase", "rds:CreateAccount", "rds:DeleteAccount",
      "rds:ResetAccountPassword", "rds:ModifyAccountDescription", "rds:GrantAccountPrivilege",
      "rds:RevokeAccountPrivilege", "rds:ModifyBackupPolicy", "rds:ModifyDBInstanceMaintainTime",
      "rds:TagResources", "rds:UntagResources", "rds:Describe*", "rds:List*",
      "kvstore:CreateInstance", "kvstore:DeleteInstance", "kvstore:ModifyInstanceSpec",
      "kvstore:ModifyInstanceAttribute", "kvstore:ModifyInstanceMaintainTime", "kvstore:ModifySecurityIps",
      "kvstore:ModifyInstanceConnection", "kvstore:AllocateInstancePublicConnection",
      "kvstore:ResetAccountPassword", "kvstore:TagResources", "kvstore:UntagResources",
      "kvstore:Describe*", "kvstore:List*",
      "oss:PutBucket", "oss:PutBucketAcl", "oss:PutBucketVersioning", "oss:PutBucketTagging",
      "oss:PutBucketLogging", "oss:PutBucketEncryption", "oss:DeleteBucket", "oss:DeleteBucketTagging",
      "oss:GetBucketInfo", "oss:GetBucketAcl", "oss:GetBucketVersioning", "oss:GetBucketTagging",
      "oss:GetBucketLocation", "oss:GetBucketStat", "oss:ListBuckets", "oss:GetObject", "oss:PutObject",
      "oss:DeleteObject", "oss:ListObjects", "oss:AbortMultipartUpload",
      "ots:CreateInstance", "ots:DeleteInstance", "ots:UpdateInstance", "ots:GetInstance",
      "ots:ListInstance", "ots:InsertInstanceTag", "ots:DeleteInstanceTag", "ots:CreateTable",
      "ots:DeleteTable", "ots:UpdateTable", "ots:DescribeTable", "ots:ListTable", "ots:Get*",
      "ots:List*", "ots:Describe*",
      "kms:CreateSecret", "kms:UpdateSecret", "kms:PutSecretValue", "kms:GetSecretValue",
      "kms:UpdateSecretVersionStage", "kms:DeleteSecret", "kms:RestoreSecret", "kms:TagResource",
      "kms:UntagResource", "kms:DescribeSecret", "kms:ListSecrets", "kms:ListSecretVersionIds",
      "kms:Describe*", "kms:List*", "kms:Get*",
    ]
    # Container Registry + AliDNS + Message Service + WAF v3.
    EdgeReg = [
      "cr:CreateInstance", "cr:GetInstance", "cr:GetInstanceEndpoint", "cr:ListInstance",
      "cr:ListInstanceEndpoint", "cr:CreateNamespace", "cr:UpdateNamespace", "cr:DeleteNamespace",
      "cr:GetNamespace", "cr:ListNamespace", "cr:CreateInstanceVpcEndpointLinkedVpc", "cr:TagResources",
      "cr:UntagResources", "cr:Get*", "cr:List*",
      "alidns:AddDomain", "alidns:DeleteDomain", "alidns:ChangeDomainGroup", "alidns:UpdateDomainRemark",
      "alidns:AddDomainRecord", "alidns:UpdateDomainRecord", "alidns:DeleteDomainRecord",
      "alidns:SetDomainRecordStatus", "alidns:TagResources", "alidns:UntagResources", "alidns:Describe*",
      "alidns:List*", "alidns:Get*",
      "mns:CreateQueue", "mns:DeleteQueue", "mns:SetQueueAttributes", "mns:GetQueueAttributes",
      "mns:ListQueue", "mns:CreateTopic", "mns:DeleteTopic", "mns:SetTopicAttributes",
      "mns:GetTopicAttributes", "mns:ListTopic", "mns:TagResources", "mns:UntagResources", "mns:Get*",
      "mns:List*",
      "yundun-waf:CreateInstance", "yundun-waf:DeleteInstance", "yundun-waf:ModifyInstance",
      "yundun-waf:DescribeInstance", "yundun-waf:DescribeInstanceInfo", "yundun-waf:DescribeInstanceSpecInfo",
      "yundun-waf:Describe*", "yundun-waf:Get*", "yundun-waf:List*",
    ]
  }
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

# The 4 enumerated custom provisioning policies (see the locals above) + their attachments — replacing
# the per-service System `*FullAccess` policies. Each is `Resource: "*"` (enumerated ACTION sets; RAM
# ARN scoping is inconsistent across these services, so action-scoping is the reliable lever).
resource "alicloud_ram_policy" "provision" {
  for_each    = local.provisioning_custom_policies
  policy_name = "${var.role_name}-${each.key}"
  policy_document = jsonencode({
    Version   = "1"
    Statement = [{ Effect = "Allow", Action = each.value, Resource = "*" }]
  })
  description = "Enumerated least-priv (no service:*) for the ${each.key} services Alethia provisions."
}

resource "alicloud_ram_role_policy_attachment" "provision" {
  for_each    = alicloud_ram_policy.provision
  role_name   = alicloud_ram_role.alethia.id
  policy_name = each.value.policy_name
  policy_type = "Custom"
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
