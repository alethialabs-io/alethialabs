locals {
  redis_security_group_name = format("%s-redis-cluster", local.resource_tag)
  redis_security_group_ingress_rules = [
    {
      description        = "Allows communication with Redis hosts via CIDRs blocks"
      from_port          = var.port
      to_port            = var.port
      protocol           = "tcp"
      cidr_blocks        = var.allowed_cidr_blocks
      security_group_ids = null
      enabled            = length(var.allowed_cidr_blocks) > 0 ? true : false
    },
    {
      description        = "Allows communication with Redis hosts via source security groups"
      from_port          = var.port
      to_port            = var.port
      protocol           = "tcp"
      cidr_blocks        = null
      security_group_ids = var.allowed_security_group_ids
      enabled            = length(var.allowed_security_group_ids) > 0 ? true : false
    },
  ]
}

#tfsec:ignore:aws-ec2-require-vpc-flow-logs-for-all-vpcs
resource "aws_security_group" "redis_cluster_sg" {
  name        = local.redis_security_group_name
  description = "Rules for Elasticache Redis cluster"
  vpc_id      = var.vpc_id
  tags                                 = var.redis_tags
  dynamic "ingress" {
    for_each = [
      for rules in local.redis_security_group_ingress_rules : rules
      if rules.enabled
    ]
    content {
      description     = ingress.value.description
      from_port       = ingress.value.from_port
      to_port         = ingress.value.to_port
      protocol        = ingress.value.protocol
      security_groups = ingress.value.security_group_ids
      cidr_blocks     = ingress.value.cidr_blocks
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}
