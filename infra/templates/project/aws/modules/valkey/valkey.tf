module "elasticache_serverless_valkey" {
  source  = "terraform-aws-modules/elasticache/aws//modules/serverless-cache"
  version = "~> 1.4"

  cache_name = "${local.resource_tag}-valkey"
  engine     = "valkey"

  cache_usage_limits = {
    data_storage = {
      maximum = var.data_storage_max
    }
    ecpu_per_second = {
      maximum = var.ecpu_per_second_max
    }
  }

  daily_snapshot_time  = var.snapshot_time
  description          = "Serverless Valkey cache for ${var.product_name} in ${var.environment}"
  major_engine_version = var.engine_version
  security_group_ids   = [aws_security_group.valkey_sg.id]
  subnet_ids           = var.subnet_ids # slice(module.common_vpc.database_subnets, 0, 2)
  user_group_id        = var.create_valkey_user_and_secret ? aws_elasticache_user_group.valkey_users[0].id : null

  tags = {
    Name        = "${var.product_name}-${var.environment}-valkey"
    Environment = var.environment
    Product     = var.product_name
    Bango       = local.resource_tag
  }
}

resource "random_password" "valkey_special_password" {
  count            = var.create_valkey_user_and_secret ? 1 : 0
  length           = 20
  special          = true
  override_special = "!&#^<>-"
}

resource "aws_elasticache_user" "valkey_user" {
  count         = var.create_valkey_user_and_secret ? 1 : 0
  user_id       = local.valkey_user_name
  user_name     = local.valkey_user_name
  engine        = "valkey"
  passwords     = [random_password.valkey_special_password[0].result]
  access_string = "on ~* +@all"
}

resource "aws_elasticache_user_group" "valkey_users" {
  count         = var.create_valkey_user_and_secret ? 1 : 0
  user_group_id = local.valkey_user_group_name
  engine        = "valkey"
  user_ids      = [aws_elasticache_user.valkey_user[0].user_id]
}

resource "aws_security_group" "valkey_sg" {
  name        = "valkey-serverless-sg"
  description = "Security group for serverless Valkey allowing access from another SG"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Allow TCP traffic from trusted security groups"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.redis_allowed_security_group_ids
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "valkey-serverless-sg"
  }
}

module "valkey_additional_secrets" {
  count      = var.create_valkey_user_and_secret ? 1 : 0
  depends_on = [random_password.valkey_special_password]

  source  = "lgallard/secrets-manager/aws"
  version = "0.6.2"

  secrets = {
    (local.valkey_user_name) = {
      secret_key_value = {
        username = local.valkey_user_name
        password = random_password.valkey_special_password[0].result
      }
    }
  }
}
