terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------- locals ----------

locals {
  name_prefix = "${var.name_prefix}-${var.region}"
}

# ---------- ECS cluster ----------

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

# ---------- Task definition ----------

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
      name      = "tendril"
      image     = "${var.image}:${var.tendril_version}"
      essential = true

      environment = [
        { name = "GRAPE_WORKER_MODE", value = var.worker_mode },
        { name = "GRAPE_WEB_ORIGIN", value = var.trellis_url },
        { name = "GRAPE_WORKER_ID", value = var.worker_id },
        { name = "SUPABASE_S3_ENDPOINT", value = var.supabase_s3_endpoint },
        { name = "SUPABASE_S3_REGION", value = var.supabase_s3_region },
      ]

      secrets = [
        {
          name      = "GRAPE_WORKER_TOKEN"
          valueFrom = aws_secretsmanager_secret.worker_token.arn
        },
        {
          name      = "INFRACOST_API_KEY"
          valueFrom = aws_secretsmanager_secret.infracost_key.arn
        },
        {
          name      = "SUPABASE_STORAGE_KEY_ID"
          valueFrom = aws_secretsmanager_secret.supabase_storage_key_id.arn
        },
        {
          name      = "SUPABASE_STORAGE_SECRET_KEY"
          valueFrom = aws_secretsmanager_secret.supabase_storage_secret_key.arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "tendril"
        }
      }
    }
  ])
}

# ---------- ECS service (scale-to-zero; Lambda scaler manages desired_count) ----------

resource "aws_ecs_service" "worker" {
  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.worker.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  network_configuration {
    assign_public_ip = var.assign_public_ip
    security_groups  = [aws_security_group.worker.id]
    subnets          = var.subnet_ids
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

# ---------- Security group (outbound-only) ----------

resource "aws_security_group" "worker" {
  name        = "${local.name_prefix}-sg"
  description = "Tendril worker - outbound only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "all_outbound" {
  security_group_id = aws_security_group.worker.id
  description       = "Allow all outbound (HTTPS to Trellis, git, registries, AWS APIs)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------- CloudWatch logs ----------

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30
}

# ---------- Secrets Manager ----------

resource "aws_secretsmanager_secret" "worker_token" {
  name                    = "${local.name_prefix}-worker-token"
  description             = "Tendril worker authentication token"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "worker_token" {
  secret_id     = aws_secretsmanager_secret.worker_token.id
  secret_string = var.worker_token
}

resource "aws_secretsmanager_secret" "infracost_key" {
  name                    = "${local.name_prefix}-infracost-key"
  description             = "Infracost API key for cost estimation"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "infracost_key" {
  secret_id     = aws_secretsmanager_secret.infracost_key.id
  secret_string = var.infracost_api_key
}

resource "aws_secretsmanager_secret" "supabase_storage_key_id" {
  name                    = "${local.name_prefix}-supabase-s3-key-id"
  description             = "Supabase Storage S3 access key ID for Terraform state"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "supabase_storage_key_id" {
  secret_id     = aws_secretsmanager_secret.supabase_storage_key_id.id
  secret_string = var.supabase_storage_key_id
}

resource "aws_secretsmanager_secret" "supabase_storage_secret_key" {
  name                    = "${local.name_prefix}-supabase-s3-secret-key"
  description             = "Supabase Storage S3 secret access key for Terraform state"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "supabase_storage_secret_key" {
  secret_id     = aws_secretsmanager_secret.supabase_storage_secret_key.id
  secret_string = var.supabase_storage_secret_key
}

# ---------- IAM ----------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- Execution role: pulls images, reads secrets, writes logs ---

resource "aws_iam_role" "execution" {
  name               = "${local.name_prefix}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "secrets-access"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.worker_token.arn,
          aws_secretsmanager_secret.infracost_key.arn,
          aws_secretsmanager_secret.supabase_storage_key_id.arn,
          aws_secretsmanager_secret.supabase_storage_secret_key.arn,
        ]
      }
    ]
  })
}

# --- Task role: what the running container can do ---

resource "aws_iam_role" "task" {
  name               = "${local.name_prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_admin" {
  count      = var.worker_mode == "self-hosted" ? 1 : 0
  role       = aws_iam_role.task.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_role_policy" "task_assume_customer" {
  count = var.worker_mode == "cloud-hosted" ? 1 : 0
  name  = "assume-customer-roles"
  role  = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/GrapeProvisionerRole-*"
      }
    ]
  })
}
