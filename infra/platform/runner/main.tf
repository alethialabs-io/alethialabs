terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
  }
}

# ---------- locals ----------

locals {
  name_prefix = var.name_prefix
}

# ---------- Runner auto-registration ----------

resource "null_resource" "register_runner" {
  triggers = {
    name_prefix = var.name_prefix
  }

  provisioner "local-exec" {
    command = <<-EOT
      RESPONSE=$(curl -sf -X POST "${var.alethia_url}/api/runners/register" \
        -H "Authorization: Bearer ${var.alethia_api_secret}" \
        -H "Content-Type: application/json" \
        -d '{"name": "${var.name_prefix}", "mode": "cloud-hosted"}')

      RUNNER_ID=$(echo "$RESPONSE" | jq -r '.runner_id')
      RUNNER_TOKEN=$(echo "$RESPONSE" | jq -r '.runner_token')

      echo "{\"runner_id\": \"$RUNNER_ID\", \"runner_token\": \"$RUNNER_TOKEN\"}" > ${path.module}/.registered-${var.name_prefix}.json
    EOT
  }
}

data "local_file" "registration" {
  depends_on = [null_resource.register_runner]
  filename   = "${path.module}/.registered-${var.name_prefix}.json"
}

locals {
  registration = jsondecode(data.local_file.registration.content)
  runner_id    = local.registration.runner_id
  runner_token = local.registration.runner_token
}

# ---------- VPC ----------

resource "aws_vpc" "runner" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name_prefix}-${var.region}-vpc" }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.runner.id
  cidr_block              = cidrsubnet(aws_vpc.runner.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name_prefix}-${var.region}-public-${count.index}" }
}

resource "aws_internet_gateway" "runner" {
  vpc_id = aws_vpc.runner.id
  tags   = { Name = "${var.name_prefix}-${var.region}-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.runner.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.runner.id
  }

  tags = { Name = "${var.name_prefix}-${var.region}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------- ECS cluster ----------

resource "aws_ecs_cluster" "runner" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "runner" {
  cluster_name       = aws_ecs_cluster.runner.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---------- Task definition ----------

resource "aws_ecs_task_definition" "runner" {
  family                   = "${local.name_prefix}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "runner"
      image     = "${var.image}:${var.runner_version}"
      essential = true

      environment = [
        { name = "ALETHIA_RUNNER_MODE", value = var.runner_mode },
        { name = "ALETHIA_WEB_ORIGIN", value = var.alethia_url },
        { name = "ALETHIA_RUNNER_ID", value = local.runner_id },
        { name = "ALETHIA_STORAGE_ENDPOINT", value = var.storage_endpoint },
        { name = "ALETHIA_STORAGE_REGION", value = var.storage_region },
      ]

      secrets = [
        {
          name      = "ALETHIA_RUNNER_TOKEN"
          valueFrom = aws_secretsmanager_secret.runner_token.arn
        },
        {
          name      = "INFRACOST_API_KEY"
          valueFrom = aws_secretsmanager_secret.infracost_key.arn
        },
        {
          name      = "ALETHIA_STORAGE_ACCESS_KEY_ID"
          valueFrom = aws_secretsmanager_secret.storage_key_id.arn
        },
        {
          name      = "ALETHIA_STORAGE_SECRET_ACCESS_KEY"
          valueFrom = aws_secretsmanager_secret.storage_secret_key.arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.runner.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "runner"
        }
      }
    }
  ])
}

# ---------- ECS service (scale-to-zero; Lambda scaler manages desired_count) ----------

resource "aws_ecs_service" "runner" {
  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.runner.id
  task_definition = aws_ecs_task_definition.runner.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.runner.id]
    subnets          = aws_subnet.public[*].id
  }

  propagate_tags = "TASK_DEFINITION"

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

# ---------- Security group (outbound-only) ----------

resource "aws_security_group" "runner" {
  name        = "${local.name_prefix}-sg"
  description = "Runner - outbound only"
  vpc_id      = aws_vpc.runner.id
}

resource "aws_vpc_security_group_egress_rule" "all_outbound" {
  security_group_id = aws_security_group.runner.id
  description       = "Allow all outbound (HTTPS to Alethia, git, registries, AWS APIs)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------- CloudWatch logs ----------

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30
}

# ---------- Secrets Manager ----------

resource "aws_secretsmanager_secret" "runner_token" {
  name                    = "${local.name_prefix}-runner-token"
  description             = "Runner authentication token (auto-registered)"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "runner_token" {
  secret_id     = aws_secretsmanager_secret.runner_token.id
  secret_string = coalesce(local.runner_token, "pending")
}

resource "aws_secretsmanager_secret" "infracost_key" {
  name                    = "${local.name_prefix}-infracost-key"
  description             = "Infracost API key for cost estimation"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "infracost_key" {
  secret_id     = aws_secretsmanager_secret.infracost_key.id
  secret_string = coalesce(var.infracost_api_key, "not-set")
}

resource "aws_secretsmanager_secret" "storage_key_id" {
  name                    = "${local.name_prefix}-storage-s3-key-id"
  description             = "S3-compatible storage access key ID for Terraform state"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "storage_key_id" {
  secret_id     = aws_secretsmanager_secret.storage_key_id.id
  secret_string = var.storage_access_key_id
}

resource "aws_secretsmanager_secret" "storage_secret_key" {
  name                    = "${local.name_prefix}-storage-s3-secret-key"
  description             = "S3-compatible storage secret access key for Terraform state"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "storage_secret_key" {
  secret_id     = aws_secretsmanager_secret.storage_secret_key.id
  secret_string = var.storage_secret_access_key
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
          aws_secretsmanager_secret.runner_token.arn,
          aws_secretsmanager_secret.infracost_key.arn,
          aws_secretsmanager_secret.storage_key_id.arn,
          aws_secretsmanager_secret.storage_secret_key.arn,
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
  count      = var.runner_mode == "self-hosted" ? 1 : 0
  role       = aws_iam_role.task.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_role_policy" "task_assume_customer" {
  count = var.runner_mode == "cloud-hosted" ? 1 : 0
  name  = "assume-customer-roles"
  role  = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = "arn:aws:iam::*:role/AlethiaProvisionerRole-*"
      }
    ]
  })
}
