module "s3_bucket" {
  count  = var.s3_create ? 1 : 0
  source = "./modules/s3"


  region       = var.region
  environment  = var.environment
  project_name = var.project_name

  # s3 bucket configuration
  bucket_configuration = var.bucket_configuration


}