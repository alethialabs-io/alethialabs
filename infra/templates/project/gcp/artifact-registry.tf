module "artifact_registry" {
  source = "./modules/artifact-registry"
  count  = var.provision_artifact_registry && var.registry_provider == "native" ? 1 : 0

  project_id   = var.project_id
  region       = local.gcp_region_key
  environment  = var.environment
  project_name = var.project_name

  repos = var.artifact_registry_repos

  labels = local.gcp_default_labels
}
