#tfsec:ignore:aws-s3-encryption-customer-key
#tfsec:ignore:aws-s3-block-public-acls
#tfsec:ignore:aws-s3-block-public-policy
#tfsec:ignore:aws-s3-enable-bucket-encryption
#tfsec:ignore:aws-s3-enable-bucket-logging
#tfsec:ignore:aws-s3-enable-versioning
#tfsec:ignore:aws-s3-ignore-public-acls
#tfsec:ignore:aws-s3-no-public-buckets
#tfsec:ignore:aws-s3-specify-public-access-block
module "s3_bucket" {
  for_each           = { for bucket in var.bucket_configuration : bucket.bucket_name_suffix => bucket }
  source             = "cloudposse/s3-bucket/aws"
  version            = "~> 3.1.2"
  name               = "${local.bucket_name_prefix}-${each.value.bucket_name_suffix}"
  acl                = each.value.acl_type
  user_enabled       = each.value.create_s3_user
  versioning_enabled = each.value.versioning_enabled
  sse_algorithm      = each.value.sse_algorithm #sse_algorithm - (Required) Server-side encryption algorithm to use. Valid values are AES256, aws:kms, and aws:kms:dsse
  ssm_base_path      = "/${local.bucket_name_prefix}-s3-user/"
  # Where the IAM user's access key goes. Before #4320 this attribute was declared on
  # bucket_configuration and threaded nowhere, so cloudposse's own default (`false`) always won:
  # a bucket with `create_s3_user = true` put its secret access key in state and module outputs in
  # PLAINTEXT whatever the caller asked for, while outputs.tf here already published the SSM paths
  # as though the key were stored there. The value is the caller's, read verbatim — it only has an
  # effect when `create_s3_user` is true, because no user means no key. Note the console's own
  # default is still `false` (packages/core/cloud/aws_provider.go, buildS3Buckets); wiring the
  # knob makes an explicit `true` take effect, it does not change what the console sends.
  store_access_key_in_ssm = each.value.store_access_key_in_ssm
  # Server access logging to a bucket the caller already owns. null (the default) renders no
  # `logging` block, which is what every existing bucket has. Each source bucket logs under its own
  # name so several buckets can share one target without interleaving their objects.
  logging = each.value.logging_bucket_name == null ? null : {
    bucket_name = each.value.logging_bucket_name
    prefix      = "${local.bucket_name_prefix}-${each.value.bucket_name_suffix}/"
  }
  cors_configuration           = each.value.cors_configuration
  block_public_acls            = each.value.block_public_acls != null ? each.value.block_public_acls : true
  block_public_policy          = each.value.block_public_policy != null ? each.value.block_public_policy : true
  ignore_public_acls           = each.value.ignore_public_acls != null ? each.value.ignore_public_acls : true
  restrict_public_buckets      = each.value.restrict_public_buckets != null ? each.value.restrict_public_buckets : true
  privileged_principal_arns    = each.value.privileged_principal_arns != null ? each.value.privileged_principal_arns : []
  privileged_principal_actions = each.value.privileged_principal_actions != null ? each.value.privileged_principal_actions : []
}
