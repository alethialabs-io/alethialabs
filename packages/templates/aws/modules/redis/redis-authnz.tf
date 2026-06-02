data "aws_iam_policy_document" "redis_authnz_policy_documents" {
  for_each = var.redis_tenants
  statement {
    effect = "Allow"
    # This is to generate an uinque Policy Sid by hashing the composition of redis engine id and tenant name
    sid = format("RedisTenantPolicySidHash%s", substr(sha256(format("%s-%s", module.redis.id, each.key)), 0, 5))

    actions = ["elasticache:Connect"]

    resources = [
      module.redis.arn,
      aws_elasticache_user.iam_tenants[each.key].arn,
    ]
  }
}

# Create cluster scoped tenant policy
resource "aws_iam_policy" "redis_authnz_policies" {
  for_each    = var.attach_policy_to_tenant_roles ? var.redis_tenants : {}
  name        = format("%s-tenant-%s-policy", module.redis.id, each.key)
  description = format("Policy for Redis tenant %s in cluster %s", each.key, module.redis.id)
  policy      = data.aws_iam_policy_document.redis_authnz_policy_documents[each.key].json
}

# Associate tenant IAM policy to relevant role
resource "aws_iam_role_policy_attachment" "redis_attach_to_tenant" {
  for_each   = var.attach_policy_to_tenant_roles ? var.redis_tenants : {}
  role       = each.value.role_name
  policy_arn = aws_iam_policy.redis_authnz_policies[each.key].arn
}


# Create. noop, restricted default user as required to create an user-group:
# Error: creating ElastiCache User Group (dummy): DefaultUserRequired: User group needs to contain a user with the user name default.
# https://aws.amazon.com/blogs/database/simplify-managing-access-to-amazon-elasticache-for-redis-clusters-with-iam/
resource "aws_elasticache_user" "default_user" {
  count                = var.aws_existing_default_user ? 0 : 1
  user_id              = local.redis_default_user_id
  user_name            = var.aws_elasticache_user_name
  access_string        = var.aws_elasticache_user_permission
  engine               = "REDIS"
  no_password_required = true
}

# Create tenant users with IAM authentication
resource "aws_elasticache_user" "iam_tenants" {
  for_each      = var.redis_tenants
  user_id       = each.key
  user_name     = each.key
  access_string = each.value.access_string
  engine        = "REDIS"

  authentication_mode {
    type = "iam"
  }
}

# Create default cluster user_group
resource "aws_elasticache_user_group" "redis_tenants" {
  engine        = "REDIS"
  user_group_id = local.redis_user_group_name
  user_ids      = var.aws_existing_default_user ? [local.redis_default_user_id] : [aws_elasticache_user.default_user[0].user_id]

  lifecycle {
    ignore_changes        = [user_ids]
    create_before_destroy = true
  }
  depends_on = [aws_elasticache_user.default_user]
}

resource "time_sleep" "wait_30_seconds" {
  depends_on = [module.redis,aws_elasticache_user_group.redis_tenants]
  destroy_duration = "40s"
  create_duration = "20s"
}
# Associate tenants to default cluster user_group
resource "aws_elasticache_user_group_association" "redis_associate_users_to_tenants_group" {
  for_each      = var.redis_tenants
  user_group_id = aws_elasticache_user_group.redis_tenants.user_group_id
  user_id       = aws_elasticache_user.iam_tenants[each.key].user_id

  depends_on = [module.redis,aws_elasticache_user_group.redis_tenants,time_sleep.wait_30_seconds]
}



resource "random_password" "redis_special_password" {
  length           = 20
  special          = true
  override_special = "!&#^<>-"
}

resource "aws_kms_key" "redis_secrets_kms_key" {
  description         = "KMS key to be used to encrypt the Additional redis user secrets"
  enable_key_rotation = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Full Access for root account"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = ["kms:*"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_elasticache_user" "redis_password_user" {
  user_id       = local.redis_user_name
  user_name     = local.redis_user_name
  access_string = "on ~* +@all"
  engine        = "REDIS"

  authentication_mode {
    type      = "password"
    passwords = [random_password.redis_special_password.result]
  }
}

resource "aws_elasticache_user_group_association" "redis_associate_password_user_to_group" {
  user_group_id = aws_elasticache_user_group.redis_tenants.user_group_id
  user_id       = aws_elasticache_user.redis_password_user.user_id
  depends_on    = [module.redis,aws_elasticache_user_group.redis_tenants]
}

module "redis_additional_secrets" {
  source  = "lgallard/secrets-manager/aws"
  version = "0.6.2"
  tags    = var.redis_tags
  secrets = {
    (local.redis_user_name) = {
      kms_key_id = aws_kms_key.redis_secrets_kms_key.arn
      secret_key_value = {
        username = local.redis_user_name
        password = random_password.redis_special_password.result
      }
      recovery_window_in_days = 0
    }
  }

}
