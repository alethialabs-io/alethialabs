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

variable "project_name" {
  type        = string
  description = "Name of the project / client / product to be used in naming convention"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account to deploy resources"
}
################################################################################
# Networking variables
################################################################################
variable "rds_vpc_id" {
  type        = string
  description = "VPC ID to create the cluster in (e.g. `vpc-a22222ee`)"
}

variable "rds_subnets" {
  type        = list(string)
  description = "List of VPC subnet IDs"
}

variable "rds_security_groups" {
  type        = list(string)
  default     = []
  description = "List of security groups to be allowed to connect to the DB instance"
}

variable "rds_allowed_cidr_blocks" {
  type        = list(string)
  default     = []
  description = "List of CIDRs to be allowed to connect to the DB instance"
}

################################################################################
# RDS variables
################################################################################
variable "rds_cluster_name" {
  description = "Name of the RDS Cluster"
  type        = string
  default     = ""
}

variable "rds_config" {
  description = "Configuration for RDS resources"
  type = object({
    engine         = string
    engine_version = string
    engine_mode    = string
    cluster_family = string
    cluster_size   = number
    db_port        = number
    db_name        = string
  })
  default = ({
    engine         = "aurora-postgresql"
    engine_version = "14.5"
    engine_mode    = "provisioned"
    cluster_family = "aurora-postgresql14"
    cluster_size   = 2
    db_port        = 5432
    db_name        = ""
  })
}
variable "rds_scaling_config" {
  description = "The minimum and maximum number of Aurora capacity units (ACUs) for a DB instance"
  type = object({
    min_capacity = number
    max_capacity = number
  })
  default = ({
    min_capacity = 1.0
    max_capacity = 4.0
    }
  )
}
variable "rds_storage_encrypted" {
  type        = bool
  description = "Specifies whether the DB cluster is encrypted"
  default     = true
}
variable "rds_default_username" {
  type        = string
  description = "DB username"
  default     = "bango"
}
variable "rds_iam_auth_enabled" {
  type        = bool
  description = "Specifies whether or mappings of AWS Identity and Access Management (IAM) accounts to database accounts is enabled"
  default     = false
}
variable "rds_extra_credentials" {
  description = "Database extra credentials"
  type = object({
    username = string
    password = optional(string)
    database = string
  })
  default = {
    username = "demouser"
    database = "demodb"
  }
}
variable "rds_tags" {
  type    = map(string)
  default = {}
}

variable "rds_cluster_parameters" {
  type = list(object({
    name         = string
    value        = string
    apply_method = string
  }))
  default = []
}
################################################################################
# Logs, Monitoring and Perforamnce Insights variables
################################################################################
variable "rds_logs_exports" {
  type        = list(string)
  description = "List of log types to export to cloudwatch. Aurora MySQL: audit, error, general, slowquery. Aurora PostgreSQL: postgresql"
}
variable "rds_monitoring_interval" {
  type        = number
  description = "The interval, in seconds, between points when enhanced monitoring metrics are collected for the DB instance"
  default     = 10
}
variable "rds_monitoring_role_enabled" {
  type        = bool
  description = "The creation of the enhanced monitoring IAM role"
  default     = true
}
variable "rds_performance" {
  type        = bool
  description = "Whether to enable Performance Insights"
  default     = true
}
variable "rds_performance_retention" {
  type        = number
  description = "Amount of time in days to retain Performance Insights data. Either 7 (7 days) or 731 (2 years)"
  default     = 7
}
variable "rds_auto_minor_version_upgrade" {
  type        = bool
  description = "Indicates that minor engine upgrades will be applied automatically to the DB instance during the maintenance window"
  default     = false
}
#variable "enable_rds_s3_exports" {
#  type        = bool
#  description = "If a the s3 exports needs to be enabled"
#  default     = false
#}
#variable "bucket_to_export_name" {
#  type        = string
#  description = "Variable to set the name of the bucket in the policy to export data from the database to S3"
#  default     = ""
#}

variable "rds_instance_type" {
  description = "Instance type - can be changed to db.t2.small for a non-serverless db"
  type        = string
  default     = "db.serverless"
}

################################################################################
# Backup variables
################################################################################

variable "rds_backup_retention_period" {
  type        = number
  default     = 5
  description = "Number of days to retain backups for"
}
