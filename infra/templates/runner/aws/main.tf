terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Environment = "Prod"
      Service     = "runner"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name_prefix = "runner-${substr(var.runner_id, 0, 8)}"
  tags = {
    ManagedBy = "alethia"
    RunnerID  = var.runner_id
    Name      = var.runner_name
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_ecs_cluster" "runner" {
  name = local.name_prefix
  tags = local.tags

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 7
  tags              = local.tags
}

resource "aws_iam_role" "task_execution" {
  name = "${local.name_prefix}-exec"
  tags = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name = "${local.name_prefix}-task"
  tags = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "task_permissions" {
  name = "${local.name_prefix}-permissions"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:*",
          "ec2:*",
          "events:*",
          "route53:*",
          "iam:*",
          "eks:*",
          "elasticache:*",
          "rds:*",
          "dynamodb:*",
          "sqs:*",
          "sns:*",
          "ecr:*",
          "secretsmanager:*",
          "kms:*",
          "logs:*",
          "ecs:*",
          "wafv2:*",
          "acm:*",
          "elasticloadbalancing:*",
          "autoscaling:*",
          "cloudwatch:*",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_security_group" "runner" {
  name_prefix = "${local.name_prefix}-"
  vpc_id      = data.aws_vpc.default.id
  tags        = local.tags

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_task_definition" "runner" {
  family                   = local.name_prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  tags                     = local.tags

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "runner"
    image     = "${var.image_repository}:${var.image_tag}"
    essential = true

    environment = [
      { name = "ALETHIA_RUNNER_ID", value = var.runner_id },
      { name = "ALETHIA_RUNNER_TOKEN", value = var.runner_token },
      { name = "ALETHIA_WEB_ORIGIN", value = var.alethia_url },
      { name = "ALETHIA_RUNNER_MODE", value = "self-hosted" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.runner.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "runner"
      }
    }
  }])
}

resource "aws_ecs_service" "runner" {
  name            = local.name_prefix
  cluster         = aws_ecs_cluster.runner.id
  task_definition = aws_ecs_task_definition.runner.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  tags            = local.tags

  propagate_tags = "TASK_DEFINITION"

  network_configuration {
    subnets          = length(var.subnet_ids) > 0 ? var.subnet_ids : data.aws_subnets.default.ids
    security_groups  = [aws_security_group.runner.id]
    assign_public_ip = var.assign_public_ip
  }
}
