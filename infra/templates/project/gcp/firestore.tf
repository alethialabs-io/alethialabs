module "firestore" {
  source = "./modules/firestore"
  count  = var.create_firestore ? 1 : 0

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  database_type = var.firestore_database_type
  location_id   = var.firestore_location_id != "" ? var.firestore_location_id : var.region

  labels = local.gcp_default_labels
}
