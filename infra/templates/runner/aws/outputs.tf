output "cluster_arn" {
  value       = aws_ecs_cluster.worker.arn
  description = "ECS cluster ARN"
}

output "service_name" {
  value       = aws_ecs_service.worker.name
  description = "ECS service name"
}

output "task_definition_arn" {
  value       = aws_ecs_task_definition.worker.arn
  description = "ECS task definition ARN"
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "IAM role ARN for the worker task"
}

output "log_group" {
  value       = aws_cloudwatch_log_group.worker.name
  description = "CloudWatch log group name"
}
