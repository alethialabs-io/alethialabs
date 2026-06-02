locals {
  aws_regions_short = {
    "ap-east-1"      = "ae1"
    "ap-northeast-1" = "an1"
    "ap-northeast-2" = "an2"
    "ap-northeast-3" = "an3"
    "ap-south-1"     = "as0"
    "ap-southeast-1" = "as1"
    "ap-southeast-2" = "as2"
    "ca-central-1"   = "cc1"
    "eu-central-1"   = "ec1"
    "eu-north-1"     = "en1"
    "eu-south-1"     = "es1"
    "eu-west-1"      = "ew1"
    "eu-west-2"      = "ew2"
    "eu-west-3"      = "ew3"
    "af-south-1"     = "fs1"
    "me-south-1"     = "ms1"
    "sa-east-1"      = "se1"
    "us-east-1"      = "ue1"
    "us-east-2"      = "ue2"
    "us-west-1"      = "uw1"
    "us-west-2"      = "uw2"
  }

  namespace   = "itgix"
  environment = local.aws_regions_short[var.aws_region]
  stage       = var.environment
  name        = var.product_name

  resource_tag = format("%s-%s-%s", local.aws_regions_short[var.aws_region], var.environment, var.product_name)

  redis_name                    = format("redis-%s", local.resource_tag)
  redis_description             = format("Redis instance %s", local.resource_tag)
  redis_user_group_name         = format("%s", local.resource_tag)
  associated_security_group_ids = concat([aws_security_group.redis_cluster_sg.id], var.additional_security_group_ids_to_associate)
  redis_default_user_id         = format("restricted-%s-%s-user", var.environment, var.aws_elasticache_user_name)
  redis_user_name               = format("redis-%s-%s-%s", local.aws_regions_short[var.aws_region], var.environment, var.product_name)
}

