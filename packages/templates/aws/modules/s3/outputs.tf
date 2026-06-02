output "bucket_name" {
  value       = values(module.s3_bucket)[*].bucket_id
  description = "List of bucket names"
}

output "bucket_arn" {
  value       = values(module.s3_bucket)[*].bucket_arn
  description = "List of bucket ARNs"
}

output "regional_domain_name" {
  value       = values(module.s3_bucket)[*].bucket_regional_domain_name
  description = "List of regional domain names"
}

output "user_enabled" {
  value = {
    for bucket in var.bucket_configuration : bucket.bucket_name_suffix => module.s3_bucket[bucket.bucket_name_suffix].user_enabled
  }
  description = "Confirms whether a user is being created for the bucket"
}

output "user_arn" {
  value = {
    for bucket in var.bucket_configuration : bucket.bucket_name_suffix => module.s3_bucket[bucket.bucket_name_suffix].user_arn
  }
  description = "The ARN of the create S3 User"
}

output "user_name" {
  value = {
    for bucket in var.bucket_configuration : bucket.bucket_name_suffix => module.s3_bucket[bucket.bucket_name_suffix].user_name
  }
  description = "The normalized IAM User Name"
}

output "access_key_id_ssm_path" {
  value = {
    for bucket in var.bucket_configuration : bucket.bucket_name_suffix => module.s3_bucket[bucket.bucket_name_suffix].access_key_id_ssm_path
  }
  description = "The SSM Path for the S3 user's Access Key ID"
}

output "secret_access_key_ssm_path" {
  value = {
    for bucket in var.bucket_configuration : bucket.bucket_name_suffix => module.s3_bucket[bucket.bucket_name_suffix].secret_access_key_ssm_path
  }
  description = "The SSM Path for the S3 user's Secret Access Key"
}
