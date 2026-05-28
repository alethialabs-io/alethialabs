resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30
}
