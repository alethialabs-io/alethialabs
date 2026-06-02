module "dynamodb" {
  count  = var.ddb_create ? 1 : 0
  source = "./modules/dynamodb"


  region          = var.region
  environment     = var.environment
  assume_role_arn = "arn:aws:iam::${var.aws_account_id}:role/role-terraform-deployment"

  # general table configuration
  table_configuration = var.ddb_table_configuration

}

module "global_dynamodb" {
  count  = var.ddb_global_create ? 1 : 0
  source = "./modules/dynamodb"


  region          = var.region
  environment     = var.environment
  assume_role_arn = "arn:aws:iam::${var.aws_account_id}:role/role-terraform-deployment"

  # general table configuration
  table_configuration = var.ddb_global_table_configuration

}
