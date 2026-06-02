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

variable "assume_role_arn" {
  type        = string
  description = "IAM Role to assume by the local-exec provisioner to use CLI."
  default     = ""
}

################################################################################
# Table Attributes
################################################################################

variable "table_configuration" {
  type = list(object({
    table_type        = optional(string, "regional")
    table_name_suffix = string
    hash_key          = string
    range_key         = string
    hash_key_type     = string
    range_key_type    = string
    enable_autoscaler = bool
    dynamodb_attributes = list(object({
      name = string
      type = string
    }))
    global_secondary_index_map = list(object({
      hash_key           = string
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = list(string)
      read_capacity      = number
      write_capacity     = number
    }))
    local_secondary_index_map = list(object({
      name               = string
      projection_type    = string
      range_key          = string
      non_key_attributes = list(string)
    }))
    replicas                      = list(string)
    tags_enabled                  = bool
    billing_mode                  = string
    enable_point_in_time_recovery = bool
    ttl_enabled                   = bool
    ttl_attribute                 = optional(string, "")
    deletion_protection_enabled   = optional(bool, false)
    custom_kms_key_create         = optional(bool, false)
    custom_kms_key_use            = optional(bool, false)
    trusted_principal_arns        = optional(list(string))
  }))
  description = <<EOF
      Values needed for the creation of a new table. For the value of the argument 'table_name_suffix' it should be a value that has the service name and the purpose of that table.

      <b>table_type:</b> Table type regional or global. Should be used along with replicas
      <b>table_name_suffix:</b> Suffix string that will be rendered with the table name, this is often the use for the table.
      <b>hash_key:</b> The attribute to use as the hash (partition) key. Must also be defined as an attribute.
      <b>range_key:</b> The attribute to use as the range (sort) key. Must also be defined as an attribute.
      <b>hash_key_type:</b> Hash Key type, which must be a scalar type: S, N, or B for (S)tring, (N)umber or (B)inary data.
      <b>range_key_type:</b> Range Key type, which must be a scalar type: S, N, or B for (S)tring, (N)umber or (B)inary data.
      <b>enable_autoscaler:</b> Flag to enable/disable DynamoDB autoscaling.
      <b>dynamodb_attributes:</b> Additional DynamoDB attributes in the form of a list of mapped values.
      <b>global_secondary_index_map:</b> Additional global secondary indexes in the form of a list of mapped values.
      <b>local_secondary_index_map:</b> Additional local secondary indexes in the form of a list of mapped values.
      <b>replicas:</b> List of regions to create replica.
      <b>tags_enabled:</b> Flag to enable/disable tags.
      <b>billing_mode:</b> DynamoDB Billing mode. Can be PROVISIONED or PAY_PER_REQUEST.
      <b>enable_point_in_time_recovery:</b> Flag to enable/disable point in time recovery.
      <b>ttl_enabled:</b> Flag to enable/disable TTL.
      <b>custom_kms_key_create:</b> Flag to enable/disable creation of custom KMS key (needed to allow cross account access). ⚠️ only delete a custom KMS key if it is not in use (check table KMS status in console, includes backups that need to be retained).
      <b>custom_kms_key_use:</b> Flag to enable/disable usage of custom KMS key (needed to allow cross account access). 
      <b>trusted_principal_arns:</b> List of principal ARNs allowed for cross account access
  EOF
}
