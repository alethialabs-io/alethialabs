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

  name_string = "${local.aws_regions_short[var.aws_region]}-${var.environment}-${var.project_name}"

  #rds_credentials = jsondecode(data.aws_secretsmanager_secret_version.rds_creds.secret_string)

}
