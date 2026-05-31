output "redis_replication_group_arn" {
  description = "Elasticache Redis replication Group ARN"
  value       = module.redis.arn
}

output "redis_replication_group_cluster_name" {
  description = "Elasticache Redis cluster name"
  value       = module.redis.id
}

output "redis_host" {
  description = "Redis hostname"
  value       = module.redis.host
}

output "redis_port" {
  description = "Redis port"
  value       = module.redis.port
}

output "redis_member_clusters" {
  description = "Redis cluster members"
  value       = module.redis.member_clusters
}

output "redis_security_group_id" {
  description = "The ID of the created security group"
  value       = aws_security_group.redis_cluster_sg.id
}

output "redis_security_group_name" {
  description = "The name of the created security group"
  value       = aws_security_group.redis_cluster_sg.name
}

output "redis_primary_endpoint_address" {
  description = "Redis primary or configuration endpoint, whichever is appropriate for the given cluster mode"
  value       = module.redis.endpoint
}

output "redis_reader_endpoint_address" {
  description = "The address of the endpoint for the reader node in the replication group, if the cluster mode is disabled."
  value       = module.redis.reader_endpoint_address
}

output "redis_engine_version_actual" {
  description = "The running version of the cache engine"
  value       = module.redis.engine_version_actual
}

output "redis_policy_documents_for_tenants" {
  description = "Policy documents for Redis tenants"
  value       = data.aws_iam_policy_document.redis_authnz_policy_documents
}

output "redis_secret_kms_key_arn" {
  description = "Arn of KMS key used to encrypt the secret with password"
  value       =  aws_kms_key.redis_secrets_kms_key.arn
}
