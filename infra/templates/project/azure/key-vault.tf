module "key_vault" {
  source = "./modules/key-vault"

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  # Skip native Key Vault secret provisioning when a pluggable secrets provider
  # (Vault, Doppler, …) is selected — the composed module manages those instead,
  # otherwise the same secrets double-provision. The vault shell itself stays
  # (checks.tf requires vault_uri whenever AKS is up); only its contents are gated.
  secrets = var.secrets_provider == "native" ? var.custom_secrets : []

  tags = local.azure_default_tags
}
