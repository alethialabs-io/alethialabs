output "cluster_arn" {
  description = "ECS Cluster ARN"
  value       = aws_ecs_cluster.worker.arn
}

output "service_name" {
  description = "ECS Service Name"
  value       = aws_ecs_service.worker.name
}

output "task_definition_arn" {
  description = "ECS Task Definition ARN"
  value       = aws_ecs_task_definition.worker.arn
}

output "log_group_name" {
  description = "CloudWatch Log Group"
  value       = aws_cloudwatch_log_group.worker.name
}

output "ecr_repository_url" {
  description = "ECR Repository URL (push images here)"
  value       = aws_ecr_repository.grape.repository_url
}
