output "eks_cluster_id" {
  value = module.eks.cluster_name
}

output "eks_cluster_arn" {
  value = module.eks.cluster_arn
}

output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "eks_cluster_certificate_authority_data" {
  value = module.eks.cluster_certificate_authority_data
}

output "eks_cluster_version" {
  value = module.eks.cluster_version
}

output "eks_irsa_external_dns_arn" {
  value = module.iam_assumable_role_external_dns.iam_role_arn
}

output "node_security_group_id" {
  description = "ID of the node shared security group"
  value       = module.eks.node_security_group_id
}

output "node_iam_role_name" {
  value = module.eks.eks_managed_node_groups["eks_workers"].iam_role_name
}

output "node_iam_role_arn" {
  value = module.eks.eks_managed_node_groups["eks_workers"].iam_role_arn
}

output "oidc_provider_arn" {
  description = "The ARN of the OIDC Provider if `enable_irsa = true`"
  value       = module.eks.oidc_provider_arn
}
