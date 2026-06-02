module "cloud_armor" {
  source = "./modules/cloud-armor"
  count  = var.cloud_armor_enabled ? 1 : 0

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  rules = var.cloud_armor_rules

  labels = local.gcp_default_labels
}
