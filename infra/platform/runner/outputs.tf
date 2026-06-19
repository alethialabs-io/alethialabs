output "cluster_arn" {
  description = "ECS Cluster ARN"
  value       = aws_ecs_cluster.runner.arn
}

output "cluster_name" {
  description = "ECS Cluster name"
  value       = aws_ecs_cluster.runner.name
}

output "service_name" {
  description = "ECS Service name"
  value       = aws_ecs_service.runner.name
}

output "task_definition_arn" {
  description = "ECS Task Definition ARN"
  value       = aws_ecs_task_definition.runner.arn
}

output "log_group_name" {
  description = "CloudWatch Log Group name"
  value       = aws_cloudwatch_log_group.runner.name
}
