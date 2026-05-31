output "rds_cluster_endpoint" {
  description = "RDS Cluster endpoint"
  value       = module.aurora_serverless_v2.endpoint
}

output "rds_master_credentials_secret_arn" {
  description = "RDS Master Credentials Secret ARN"
  value       = aws_secretsmanager_secret.dbsecret.arn
}

output "rds_master_credentials_secret_name" {
  description = "RDS Master Credentials Secret Name"
  value       = aws_secretsmanager_secret.dbsecret.name
}

output "rds_extra_credentials_secret_arn" {
  description = "RDS Extra Credentials Secret ARN"
  value       = aws_secretsmanager_secret.dbsecret_extra.arn
}

output "rds_extra_credentials_secret_name" {
  description = "RDS Extra Credentials Secret Name"
  value       = aws_secretsmanager_secret.dbsecret_extra.name
}

output "rds_cluster_identifier" {
  description = "The RDS Cluster Identifier"
  value       = module.aurora_serverless_v2.cluster_identifier
}

output "rds_cluster_arn" {
  description = "The RDS Cluster ARN"
  value       = module.aurora_serverless_v2.arn
}

output "rds_credentials_kms_key_arn" {
  description = "RDS Credentials kms key arn"
  value       = aws_kms_key.rds_secret_kms_key.arn
}
