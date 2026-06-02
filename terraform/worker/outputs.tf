output "cluster_arn" {
  description = "ECS Cluster ARN"
  value       = aws_ecs_cluster.tendril.arn
}

output "cluster_name" {
  description = "ECS Cluster name"
  value       = aws_ecs_cluster.tendril.name
}

output "service_name" {
  description = "ECS Service name"
  value       = aws_ecs_service.tendril.name
}

output "task_definition_arn" {
  description = "ECS Task Definition ARN"
  value       = aws_ecs_task_definition.tendril.arn
}

output "log_group_name" {
  description = "CloudWatch Log Group name"
  value       = aws_cloudwatch_log_group.tendril.name
}
