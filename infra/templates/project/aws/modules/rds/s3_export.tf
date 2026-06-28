#resource "aws_iam_role" "s3_export_role" {
#  count = var.enable_rds_s3_exports ? 1 : 0
#  name  = "policy-${local.name_string}-rds-s3-export"
#
#  assume_role_policy = <<EOF
#{
#    "Version": "2012-10-17",
#    "Statement": [
#        {
#            "Sid": "AllowSTSAssumeRoleForRDS",
#            "Effect": "Allow",
#            "Principal": {
#                "Service": "rds.amazonaws.com"
#            },
#            "Action": "sts:AssumeRole"
#        }
#    ]
#}
#EOF
#}
#
#resource "aws_iam_policy" "s3_export_policy" {
#  count       = var.enable_rds_s3_exports ? 1 : 0
#  name        = "role-${local.name_string}-rds-s3-export"
#  description = "Policy to allow authentication from the ${module.aurora_serverless_v2.name} RDS cluster to S3 buckets"
#  policy = <<EOF
#{
#    "Version": "2012-10-17",
#    "Statement": [
#        {
#            "Effect": "Allow",
#            "Action": [
#                "s3:Get*",
#                "s3:List*",
#                "s3:Put*",
#                "s3:DeleteObject",
#                "s3:AbortMultipartUpload"
#            ],
#            "Resource": [
#                "arn:aws:s3:::${var.bucket_to_export_name}"
#            ]
#        }
#    ]
#}
#EOF
#}
#
#resource "aws_iam_role_policy_attachment" "s3_export_role_policy_attachment" {
#  count      = var.enable_rds_s3_exports ? 1 : 0
#  role       = aws_iam_role.s3_export_role[0].name
#  policy_arn = aws_iam_policy.s3_export_policy[0].arn
#}
#
#resource "aws_rds_cluster_role_association" "aws_s3_role_export" {
#  count                 = var.enable_rds_s3_exports ? 1 : 0
#  db_cluster_identifier = module.aurora_serverless_v2.cluster_identifier
#  feature_name          = "s3Export"
#  role_arn              = aws_iam_role.s3_export_role[0].arn
#}
