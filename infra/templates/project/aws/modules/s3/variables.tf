################################################################################
# Provider variables
################################################################################

variable "region" {
  type        = string
  description = "AWS region to deploy to"
}

################################################################################
# Utility variables
################################################################################

variable "environment" {
  type        = string
  description = "Environment in which resources are deployed."
}

variable "project_name" {
  type        = string
  description = "Application name used in prefix"
}
################################################################################
# Bucket Attributes
################################################################################

variable "bucket_configuration" {
  type = list(object({
    bucket_name_suffix      = string
    acl_type                = string
    create_s3_user          = bool
    versioning_enabled      = bool
    sse_algorithm           = string
    store_access_key_in_ssm = bool
    block_public_acls       = optional(bool)
    block_public_policy     = optional(bool)
    ignore_public_acls      = optional(bool)
    restrict_public_buckets = optional(bool)
    cors_configuration = list(object({
      allowed_headers = list(string)
      allowed_methods = list(string)
      allowed_origins = list(string)
      expose_headers  = list(string)
      max_age_seconds = number
    }))
    privileged_principal_arns    = optional(list(map(list(string))))
    privileged_principal_actions = optional(list(string))
  }))
  description = "Values needed for the creation of a new S3 bucket. For the value of the argument 'bucket_name_suffix' it should be a value that has the service name and the purpose of that bucket."
  default = [{
    bucket_name_suffix      = ""
    acl_type                = "log-delivery-write"
    create_s3_user          = false
    versioning_enabled      = true
    sse_algorithm           = "AES256"
    store_access_key_in_ssm = true
    block_public_acls       = true
    block_public_policy     = true
    ignore_public_acls      = true
    restrict_public_buckets = true
    cors_configuration      = []
  }]
}
