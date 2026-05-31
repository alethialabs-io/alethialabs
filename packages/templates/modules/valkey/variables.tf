################################################################################
# Provider variables
################################################################################

variable "aws_region" {
  type        = string
  description = "AWS region to deploy to"
}

################################################################################
# Utility variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed"
}

variable "product_name" {
  type        = string
  description = "Bango platform instance (same as provided tag in default_tags)"
}

################################################################################
# Networking variables
################################################################################
variable "vpc_id" {
  type        = string
  description = "VPC to be used by Elasticache Redis cluster"
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnet IDs to use for this Elasticache Redis deployment"
  default     = []
}

################################################################################
# Elasticache Valkey params
################################################################################

variable "redis_allowed_security_group_ids" {
  type = list(string)
}

variable "snapshot_time" {
  type    = string
  default = "05:00"
}

variable "engine_version" {
  type    = string
  default = "7"
}

variable "data_storage_max" {
  type    = number
  default = 2
}

variable "ecpu_per_second_max" {
  type    = number
  default = 1000
}

variable "create_valkey_user_and_secret" {
  type    = bool
  default = true
}