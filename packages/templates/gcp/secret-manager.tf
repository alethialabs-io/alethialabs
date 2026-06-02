module "secret_manager" {
  source = "./modules/secret-manager"

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  secrets = var.custom_secrets

  labels = local.gcp_default_labels
}
