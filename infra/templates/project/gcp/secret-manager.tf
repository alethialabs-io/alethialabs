module "secret_manager" {
  source = "./modules/secret-manager"

  project_id   = var.project_id
  environment  = var.environment
  project_name = var.project_name

  # Skip native Secret Manager provisioning when a pluggable secrets provider
  # (Vault, Doppler, …) is selected — the composed module manages those instead,
  # otherwise the same secrets double-provision (mirrors the AWS/Alibaba pattern).
  secrets = var.secrets_provider == "native" ? var.custom_secrets : []

  labels = local.gcp_default_labels
}
