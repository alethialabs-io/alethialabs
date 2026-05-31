resource "aws_ecs_cluster" "worker" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "worker" {
  cluster_name       = aws_ecs_cluster.worker.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name_prefix}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "grape-worker"
      image     = "${aws_ecr_repository.grape.repository_url}:${var.grape_version}"
      essential = true
      command   = ["worker", "start"]

      environment = [
        { name = "GRAPE_WORKER_MODE", value = var.worker_mode },
        { name = "GRAPE_WEB_ORIGIN", value = var.trellis_url },
        { name = "GRAPE_WORKER_ID", value = var.worker_id },
      ]

      secrets = [
        {
          name      = "GRAPE_WORKER_TOKEN"
          valueFrom = aws_secretsmanager_secret.worker_token.arn
        },
        {
          name      = "INFRACOST_API_KEY"
          valueFrom = aws_secretsmanager_secret.infracost_key.arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "grape-worker"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.worker.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.worker.id]
    subnets          = var.subnet_ids
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
}
