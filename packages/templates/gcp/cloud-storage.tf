module "cloud_storage" {
  source = "./modules/cloud-storage"
  count  = var.create_cloud_storage ? 1 : 0

  project_id   = var.project_id
  region       = var.region
  environment  = var.environment
  project_name = var.project_name

  buckets = var.cloud_storage_buckets

  labels = local.gcp_default_labels
}
