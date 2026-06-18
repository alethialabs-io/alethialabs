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

# ---------- Tendril auto-registration ----------

resource "null_resource" "register_tendril" {
  triggers = {
    name_prefix = var.name_prefix
  }

  provisioner "local-exec" {
    command = <<-EOT
      RESPONSE=$(curl -sf -X POST "${var.alethia_url}/api/tendrils/register" \
        -H "Authorization: Bearer ${var.alethia_api_secret}" \
        -H "Content-Type: application/json" \
        -d '{"name": "${var.name_prefix}", "mode": "cloud-hosted"}')

      TENDRIL_ID=$(echo "$RESPONSE" | jq -r '.tendril_id')
      TENDRIL_TOKEN=$(echo "$RESPONSE" | jq -r '.tendril_token')

      echo "{\"tendril_id\": \"$TENDRIL_ID\", \"tendril_token\": \"$TENDRIL_TOKEN\"}" > ${path.module}/.registered-${var.name_prefix}.json
    EOT
  }
}

data "local_file" "registration" {
  depends_on = [null_resource.register_tendril]
  filename   = "${path.module}/.registered-${var.name_prefix}.json"
}

locals {
  registration  = jsondecode(data.local_file.registration.content)
  tendril_id    = local.registration.tendril_id
  tendril_token = local.registration.tendril_token
}

# ---------- VPC ----------

resource "aws_vpc" "tendril" {
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
  vpc_id                  = aws_vpc.tendril.id
  cidr_block              = cidrsubnet(aws_vpc.tendril.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name_prefix}-${var.region}-public-${count.index}" }
}

resource "aws_internet_gateway" "tendril" {
  vpc_id = aws_vpc.tendril.id
  tags   = { Name = "${var.name_prefix}-${var.region}-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.tendril.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.tendril.id
  }

  tags = { Name = "${var.name_prefix}-${var.region}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------- ECS cluster ----------

resource "aws_ecs_cluster" "tendril" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "tendril" {
  cluster_name       = aws_ecs_cluster.tendril.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---------- Task definition ----------

resource "aws_ecs_task_definition" "tendril" {
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
      name      = "tendril"
      image     = "${var.image}:${var.node_version}"
      essential = true

      environment = [
        { name = "ALETHIA_WORKER_MODE", value = var.worker_mode },
        { name = "ALETHIA_WEB_ORIGIN", value = var.alethia_url },
        { name = "ALETHIA_WORKER_ID", value = local.tendril_id },
        { name = "ALETHIA_STORAGE_ENDPOINT", value = var.storage_endpoint },
        { name = "ALETHIA_STORAGE_REGION", value = var.storage_region },
      ]

      secrets = [
        {
          name      = "ALETHIA_WORKER_TOKEN"
          valueFrom = aws_secretsmanager_secret.tendril_token.arn
        },
        {
          name      = "INFRACOST_API_KEY"
          valueFrom = aws_secretsmanager_secret.infracost_key.arn
        },
        {
          name      = "ALETHIA_STORAGE_ACCESS_KEY_ID"
          valueFrom = aws_secretsmanager_secret.supabase_storage_key_id.arn
        },
        {
          name      = "ALETHIA_STORAGE_SECRET_ACCESS_KEY"
          valueFrom = aws_secretsmanager_secret.supabase_storage_secret_key.arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.tendril.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "tendril"
        }
      }
    }
  ])
}

# ---------- ECS service (scale-to-zero; Lambda scaler manages desired_count) ----------

resource "aws_ecs_service" "tendril" {
  name            = "${local.name_prefix}-service"
  cluster         = aws_ecs_cluster.tendril.id
  task_definition = aws_ecs_task_definition.tendril.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.tendril.id]
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

resource "aws_security_group" "tendril" {
  name        = "${local.name_prefix}-sg"
  description = "Tendril - outbound only"
  vpc_id      = aws_vpc.tendril.id
}

resource "aws_vpc_security_group_egress_rule" "all_outbound" {
  security_group_id = aws_security_group.tendril.id
  description       = "Allow all outbound (HTTPS to Alethia, git, registries, AWS APIs)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------- CloudWatch logs ----------

resource "aws_cloudwatch_log_group" "tendril" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30
}

# ---------- Secrets Manager ----------

resource "aws_secretsmanager_secret" "tendril_token" {
  name                    = "${local.name_prefix}-tendril-token"
  description             = "Tendril authentication token (auto-registered)"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "tendril_token" {
  secret_id     = aws_secretsmanager_secret.tendril_token.id
  secret_string = coalesce(local.tendril_token, "pending")
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

resource "aws_secretsmanager_secret" "supabase_storage_key_id" {
  name                    = "${local.name_prefix}-supabase-s3-key-id"
  description             = "Supabase Storage S3 access key ID for Terraform state"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "supabase_storage_key_id" {
  secret_id     = aws_secretsmanager_secret.supabase_storage_key_id.id
  secret_string = var.storage_access_key_id
}

resource "aws_secretsmanager_secret" "supabase_storage_secret_key" {
  name                    = "${local.name_prefix}-supabase-s3-secret-key"
  description             = "Supabase Storage S3 secret access key for Terraform state"
  recovery_window_in_days = var.secrets_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "supabase_storage_secret_key" {
  secret_id     = aws_secretsmanager_secret.supabase_storage_secret_key.id
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
          aws_secretsmanager_secret.tendril_token.arn,
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
        Resource = "arn:aws:iam::*:role/AlethiaProvisionerRole-*"
      }
    ]
  })
}
