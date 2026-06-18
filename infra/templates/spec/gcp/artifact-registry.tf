module "artifact_registry" {
  source = "./modules/artifact-registry"
  count  = var.provision_artifact_registry ? 1 : 0

  project_id   = var.project_id
  region       = var.region
  environment  = var.environment
  project_name = var.project_name

  repos = var.artifact_registry_repos

  labels = local.gcp_default_labels
}
