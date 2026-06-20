module "custom_secrets_password_module" {
  source = "./modules/awssm-passgen"

  # Skip native Secrets Manager generation when a pluggable secrets provider
  # (e.g. Vault) is selected — the composed module manages those instead.
  custom_secrets = var.secrets_provider == "native" ? var.custom_secrets : []

  secret_name_prefix = "${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}-"
  secret_keepers     = var.custom_secret_keepers
}
