resource "aws_kms_key" "redis" {
  description         = "Elasticache Redis cluster encryption key"
  enable_key_rotation = true
}

module "redis" {
  source  = "cloudposse/elasticache-redis/aws"
  version = "1.2.3"

  enabled     = true
  namespace   = local.namespace
  environment = local.environment
  stage       = local.stage
  name        = local.name

  vpc_id                               = var.vpc_id
  associated_security_group_ids        = local.associated_security_group_ids
  replication_group_id                 = local.redis_name
  description                          = coalesce(var.description, local.redis_description)
  subnets                              = var.subnet_ids
  elasticache_subnet_group_name        = var.elasticache_subnet_group_name
  cluster_size                         = var.cluster_size
  instance_type                        = var.instance_type
  port                                 = var.port
  create_security_group                = false
  kms_key_id                           = aws_kms_key.redis.arn
  apply_immediately                    = true
  multi_az_enabled                     = var.multi_az_enabled
  automatic_failover_enabled           = var.automatic_failover_enabled
  engine_version                       = var.engine_version
  family                               = var.family
  cluster_mode_enabled                 = var.cluster_mode_enabled
  cluster_mode_num_node_groups         = var.cluster_mode_num_node_groups
  cluster_mode_replicas_per_node_group = var.cluster_mode_replicas_per_node_group
  parameter                            = var.parameter
  parameter_group_description          = var.parameter_group_description
  at_rest_encryption_enabled           = var.at_rest_encryption_enabled
  transit_encryption_enabled           = var.transit_encryption_enabled
  user_group_ids                       = [aws_elasticache_user_group.redis_tenants.user_group_id]
  tags                                 = var.redis_tags

  log_delivery_configuration = local.log_delivery_configuration

  depends_on = [ aws_elasticache_user_group.redis_tenants ]

  # parameter = [
  #   {
  #     name  = "notify-keyspace-events"
  #     value = "lK"
  #   }
  # ]
  ##########################################################################
}
