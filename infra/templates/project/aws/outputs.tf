output "vpc_id" {
  value = var.provision_vpc ? module.common_vpc[0].vpc_id : var.vpc_id
}

output "eks_cluster_arn" {
  value = module.eks[0].eks_cluster_arn
}

output "eks_cluster_name" {
  value = module.eks[0].eks_cluster_id
}

output "eks_cluster_endpoint" {
  value = module.eks[0].eks_cluster_endpoint
}

output "route53_zone_id" {
  description = "The Route 53 hosted zone id (created in-template when cloud_dns_enabled, else the existing dns_hosted_zone)."
  value       = var.cloud_dns_enabled ? module.route53[0].zone_id : var.dns_hosted_zone
}

output "route53_name_servers" {
  description = "Authoritative name servers for the created zone (delegate these at the registrar); empty when using an existing zone."
  value       = var.cloud_dns_enabled ? module.route53[0].name_servers : []
}

#output "eks_cluster_version" {
#  value = module.eks[0].eks_cluster_version
#}

output "eks_irsa_external_dns_arn" {
  value = module.eks[0].eks_irsa_external_dns_arn
}

output "eks_irsa_alb_controller_arn" {
  value = module.eks[0].eks_irsa_alb_controller_arn
}

output "eks_irsa_external_secrets_arn" {
  description = "IRSA role ARN for the external-secrets operator (gates the AWS ClusterSecretStore render)"
  value       = module.eks[0].eks_irsa_external_secrets_arn
}

output "rds_iam_auth_irsa_arn" {
  value = length(module.rds_iam_auth) > 0 ? module.rds_iam_auth[0].iam_role_arn : null
}

output "node_iam_role_name" {
  value = module.eks[0].node_iam_role_name
}

output "node_security_group" {
  value = module.eks[0].node_security_group_id
}

output "az1" {
  value = local.azs[0]
}

output "az2" {
  value = local.azs[1]
}

output "az3" {
  value = local.azs[2]
}

output "subnet1" {
  value = var.provision_vpc ? module.common_vpc[0].private_subnets[0] : try(var.vpc_private_subnet_ids[0], null)
}

output "subnet2" {
  value = var.provision_vpc ? module.common_vpc[0].private_subnets[1] : try(var.vpc_private_subnet_ids[1], null)
}

output "subnet3" {
  value = var.provision_vpc ? module.common_vpc[0].private_subnets[2] : try(var.vpc_private_subnet_ids[2], null)
}

## RDS
output "rds_cluster_endpoint" {
  description = "RDS Cluster endpoint"
  value       = var.create_rds ? module.rds_maindb[0].rds_cluster_endpoint : null
}

output "rds_master_credentials_secret_arn" {
  description = "RDS Master Credentials Secret ARN"
  value       = var.create_rds ? module.rds_maindb[0].rds_master_credentials_secret_arn : null
}

output "rds_master_credentials_secret_name" {
  description = "RDS Master Credentials Secret Name"
  value       = var.create_rds ? module.rds_maindb[0].rds_master_credentials_secret_name : null
}

output "rds_extra_credentials_secret_arn" {
  description = "RDS Extra Credentials Secret ARN"
  value       = var.create_rds ? module.rds_maindb[0].rds_extra_credentials_secret_arn : null
}

output "rds_extra_credentials_secret_name" {
  description = "RDS Extra Credentials Secret Name"
  value       = var.create_rds ? module.rds_maindb[0].rds_extra_credentials_secret_name : null
}

output "rds_cluster_identifier" {
  description = "The RDS Cluster Identifier"
  value       = var.create_rds ? module.rds_maindb[0].rds_cluster_identifier : null
}

output "rds_cluster_arn" {
  description = "The RDS Cluster ARN"
  value       = var.create_rds ? module.rds_maindb[0].rds_cluster_arn : null
}

output "rds_credentials_kms_key_arn" {
  description = "RDS Credentials kms key arn"
  value       = var.create_rds ? module.rds_maindb[0].rds_credentials_kms_key_arn : null
}

# ACM
output "acm_certificate_arn" {
  description = "Wildcard ACM certificate ARN for the configured domain"
  value       = var.acm_certificate_enable ? module.acm[0].acm_certificate_arn : null
}

# WAF
output "waf_webacl_arn" {
  description = "RDS Credentials kms key arn"
  value       = var.application_waf_enabled ? module.wafv2_application.webacl_arn : null
}

# ECR
output "ecr_repository_names" {
  description = "Names of the repository"
  value       = module.ecr.repository_names
}
output "ecr_repository_urls_map" {
  description = "Repository URLs keyed by the component's logical name (registry / service name) — the W2 BUILD job and the manifest renderer resolve each service's push destination here"
  value       = module.ecr.repository_urls_map
}
output "ecr_build_role_arn" {
  description = "IRSA role ARN the in-cluster build ServiceAccount assumes to push images (W2 kaniko builds)"
  value       = var.provision_ecr ? module.irsa_ecr_build[0].iam_role_arn : null
}
output "ecr_build_service_account" {
  description = "The namespace:serviceaccount the build IRSA role trusts — the kaniko Job renderer must schedule builds under exactly this identity"
  value       = var.provision_ecr ? "${local.ecr_build_namespace}:${local.ecr_build_service_account}" : null
}

# Elasticache Redis

output "redis_reader_endpoint_address" {
  description = "The address of the endpoint for the reader node in the replication group, if the cluster mode is disabled."
  value       = var.create_elasticache_redis ? module.elasticache[0].redis_reader_endpoint_address : null
}

output "redis_primary_endpoint_address" {
  description = "Redis primary or configuration endpoint, whichever is appropriate for the given cluster mode"
  value       = var.create_elasticache_redis ? module.elasticache[0].redis_primary_endpoint_address : null
}
output "irsa_rds_role_arn" {
  description = "ARN of the IAM Role for access to rds database"
  value       = length(module.rds_iam_auth) > 0 ? module.rds_iam_auth[0].iam_role_arn : null
}

output "karpenter_queue_name" {
  description = "Interruption queue name for karpenter"
  value       = var.enable_karpenter ? module.karpenter[0].queue_name : null
}


output "karpenter_sa_role" {
  description = "IRSA role for karpenter SA"
  value       = var.enable_karpenter ? module.irsa_karpenter.iam_role_arn : null
}

# Label-at-source for Karpenter-launched EC2 (BYOC A1.2). Karpenter provisions instances/volumes
# via its OWN ec2:CreateFleet/RunInstances calls — NOT via OpenTofu — so the provider `default_tags`
# (main.tf) and the EKS module `tags` NEVER reach them. The ONLY lever that stamps the classification
# + sweep-handle tags (alethia:project-id / alethia:environment-id) onto Karpenter nodes is
# `spec.tags` on the EC2NodeClass CR, which is applied post-apply by the runner. This output surfaces
# the exact tag map (local.aws_default_tags — classification/sweep handles merged UNDER the winning
# platform base tags, identical to eks_tags / the EBS-CSI extraVolumeTags) so the EC2NodeClass
# renderer stamps it verbatim. Without it a guarded, environment-scoped sweeper cannot reclaim
# Karpenter-launched EC2 (the CSI-PVC / orphan-instance leak class, gap G2). The tags are
# non-sensitive, so harvesting this output into execution_metadata is safe.
output "karpenter_node_tags" {
  description = "Tag map the Karpenter EC2NodeClass spec.tags MUST carry so Karpenter-launched EC2/EBS inherit the classification + sweep-handle tags (provider default_tags do not reach Karpenter resources). Null when Karpenter is disabled."
  value       = var.enable_karpenter ? local.aws_default_tags : null
}

output "fluentbit_sa_role_arn" {
  description = "IAM Role ARN for Fluent Bit Service Account"
  value       = module.irsa_fluentbit_cloudwatch.iam_role_arn
}

# Custom Secrets

output "custom_secret_arns" {
  value = module.custom_secrets_password_module.secret_arns
}

output "custom_secret_names" {
  value = module.custom_secrets_password_module.secret_names
}

output "custom_secret_versions" {
  value = module.custom_secrets_password_module.secret_versions
}

# NOTE: The plaintext generated secret VALUES are intentionally NOT exported as a root
# output. The runner harvests root outputs into jobs.execution_metadata (persisted in the
# console Postgres), so re-exporting `module.custom_secrets_password_module.secret_values`
# leaked cleartext credentials into the DB. The values already live in AWS Secrets Manager;
# consumers use `custom_secret_arns` / `custom_secret_names` / `custom_secret_versions` to
# fetch them. The module keeps its `secret_values` output for in-module version seeding only.

output "region_short" {
  value = local.aws_regions_short[var.region]
}