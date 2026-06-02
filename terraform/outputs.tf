# ---------- ECR ----------

output "ecr_repository_url" {
  description = "ECR Repository URL (push images here)"
  value       = aws_ecr_repository.tendril.repository_url
}

# ---------- eu-west-1 worker ----------

output "eu_west_1_cluster_arn" {
  description = "ECS Cluster ARN in eu-west-1"
  value       = module.worker_eu_west_1.cluster_arn
}

output "eu_west_1_cluster_name" {
  description = "ECS Cluster name in eu-west-1"
  value       = module.worker_eu_west_1.cluster_name
}

output "eu_west_1_service_name" {
  description = "ECS Service name in eu-west-1"
  value       = module.worker_eu_west_1.service_name
}

output "eu_west_1_log_group" {
  description = "CloudWatch Log Group in eu-west-1"
  value       = module.worker_eu_west_1.log_group_name
}

# ---------- eu-central-1 worker ----------

output "eu_central_1_cluster_arn" {
  description = "ECS Cluster ARN in eu-central-1"
  value       = module.worker_eu_central_1.cluster_arn
}

output "eu_central_1_cluster_name" {
  description = "ECS Cluster name in eu-central-1"
  value       = module.worker_eu_central_1.cluster_name
}

output "eu_central_1_service_name" {
  description = "ECS Service name in eu-central-1"
  value       = module.worker_eu_central_1.service_name
}

output "eu_central_1_log_group" {
  description = "CloudWatch Log Group in eu-central-1"
  value       = module.worker_eu_central_1.log_group_name
}

# ---------- Scaler ----------

output "scaler_lambda_name" {
  description = "Scaler Lambda function name"
  value       = module.scaler.lambda_function_name
}
