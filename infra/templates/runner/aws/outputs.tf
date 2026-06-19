output "cluster_arn" {
  value       = aws_ecs_cluster.runner.arn
  description = "ECS cluster ARN"
}

output "service_name" {
  value       = aws_ecs_service.runner.name
  description = "ECS service name"
}

output "task_definition_arn" {
  value       = aws_ecs_task_definition.runner.arn
  description = "ECS task definition ARN"
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "IAM role ARN for the runner task"
}

output "log_group" {
  value       = aws_cloudwatch_log_group.runner.name
  description = "CloudWatch log group name"
}
