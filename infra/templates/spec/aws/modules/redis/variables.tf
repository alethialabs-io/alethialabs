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

variable "elasticache_subnet_group_name" {
  type        = string
  description = "Subnet group name for the ElastiCache instance"
  default     = ""
}

variable "allowed_cidr_blocks" {
  type        = list(any)
  description = "List of CIDRs allowed by the security group"
}

variable "allowed_security_group_ids" {
  type        = list(string)
  default     = []
  description = <<-EOT
    A list of IDs of Security Groups to allow access to the security group created by this module on Redis port.
  EOT
}

variable "additional_security_group_ids_to_associate" {
  type        = list(string)
  description = "A list of IDs of additional security groups to associate with created Elasticache Redis resource. Must provide all the required access"
  default     = []
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnet IDs to use for this Elasticache Redis deployment"
  default     = []
}

################################################################################
# Elasticache Redis params
################################################################################
variable "description" {
  type        = string
  description = "Elastic cache instance description"
  default     = ""
}
variable "cluster_size" {
  type        = number
  description = "Number of nodes in cluster. Ignored when cluster_mode_enabled == true"
  default     = 1
}
variable "instance_type" {
  type        = string
  description = "Elastic cache instance type"
  default     = "cache.t3.micro"
}

variable "cluster_mode_enabled" {
  type        = bool
  description = "Flag to enable/disable creation of a native redis cluster. automatic_failover_enabled must be set to true. Only 1 cluster_mode block is allowed"
  default     = true
}

variable "cluster_mode_replicas_per_node_group" {
  type        = number
  description = "Number of replica nodes in each node group. Valid values are 0 to 5. Changing this number will force a new resource"
  default     = 1
}

variable "cluster_mode_num_node_groups" {
  type        = number
  description = "Number of node groups (shards) for this Redis replication group. Changing this number will trigger an online resizing operation before other settings modifications"
  default     = 1
}


variable "multi_az_enabled" {
  type        = bool
  description = "Multi AZ (Automatic Failover must also be enabled. If Cluster Mode is enabled, Multi AZ is on by default, and this setting is ignored)"
  default     = true
}

variable "automatic_failover_enabled" {
  type        = bool
  description = "Automatic failover (Not available for T1/T2 instances)"
  default     = true
}

variable "engine_version" {
  type        = string
  description = "Redis engine version"
  default     = "7.0"
}

variable "family" {
  type        = string
  description = "Redis family"
  default     = "redis7"
}

variable "port" {
  type        = number
  description = "Redis port"
  default     = 6379
}

variable "at_rest_encryption_enabled" {
  type        = bool
  description = "Enable encryption at rest"
  default     = true
}

variable "transit_encryption_enabled" {
  type        = bool
  description = "Set true to enable encryption in transit. Forced true if var.auth_token is set"
  default     = true
}

variable "redis_tenants" {
  description = "List of tenants and relevant specs for this Redis cluster"
  type = map(object({
    access_string = string
    role_name     = string
  }))
  default = {}
}

variable "attach_policy_to_tenant_roles" {
  type        = bool
  description = "Attach needed authorization policy to tenant role. 'role_name' has to be provided in redis_tenants map"
  default     = true
}

variable "parameter" {
  type = list(object({
    name  = string
    value = string
  }))
  default     = []
  description = "A list of Redis parameters to apply. Note that parameters may differ from one Redis family to another"
}

variable "parameter_group_description" {
  type        = string
  default     = null
  description = "Managed by Terraform"
}

variable "redis_tags" {
  type    = map(string)
  default = {}
}
################################################################################
# Logging info variables
################################################################################

variable "log_format" {
  type        = string
  description = "Format type for Redis logs in  default 'opinionated' logging. One of 'text' or 'json'"
  default     = "text"
}

variable "firehose_logs_enabled" {
  type        = bool
  description = <<EOT
Indicates whether you want to enable or disable streaming Redis logs to kinesis firehose.
If default 'opinionated' logging is in use, parameter 'cloudwatch_logs_enabled' if set to true takes precedence
and logs will be shipped to CloudWatch Logs.
EOT
  default     = false

}

variable "s3_logs_enabled" {
  type        = bool
  description = "Indicates whether you want to stream Redis logs to S3 in default 'opinionated' logging.  This is requiring 'firehose_logs_enabled' to be set to true as well. "
  default     = false
}

variable "s3_log_bucket_name" {
  type        = string
  description = "Name of the S3 bucket to deliver logs to in default 'opinionated' logging.Needed if `s3_logs_enabled` or `firehose_logs_enabled` are set to `true`"
  default     = ""
}

variable "s3_logs_prefix" {
  type        = string
  description = "Prefix to prepend to the S3 folder name logs are delivered to in default 'opinionated' logging"
  default     = ""
}

variable "cloudwatch_logs_enabled" {
  type        = bool
  description = <<EOT
Indicates whether you want to enable or disable streaming Redis logs to Cloudwatch Logs.
If default 'opinionated' logging is in use, this parameter takes precedence over 'firehose_logs_enabled'
in case is set to true and log will be shipped to CloudWatch Logs.
EOT
  default     = true
  #   validation
}

variable "cloudwatch_log_group_retention_in_days" {
  type        = number
  description = "Specifies the number of days you want to retain log events in the log group"
  default     = 0
}

variable "log_delivery_configuration" {
  type        = list(map(any))
  default     = []
  description = <<EOT
The log_delivery_configuration block allows the streaming of Redis SLOWLOG or Redis Engine Log
to CloudWatch Logs or Kinesis Data Firehose. Max of 2 blocks.
Not specifying this variable is equivalent to use default 'Opinionated' Logging provided by this module.
Specifying this variable will disable the default 'opinionated' logging provided by this module.
CloudWatch Logs or Kinesis Data Firehose needed resources have to be provided by end user.
EOT
}

variable "aws_elasticache_user_name" {
  type        = string
  description = "Username for the default user. Its mandatory to have at least one default user. Change this only if you already have the default user created by other means"
  default     = "default"
}

variable "aws_elasticache_user_permission" {
  type        = string
  description = "Permissions (access_string) for the default user"
  default     = "off -@all"
}

variable "aws_existing_default_user" {
  type        = bool
  description = "Is there an existing default user"
  default     = false
}
