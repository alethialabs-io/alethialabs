module "key_vault" {
  source = "./modules/key-vault"

  location = var.location
  # Derived, not composed — the readable "<project_name>-<environment>-kv" overflows Azure's 24-char
  # cap for any realistic name (#1873). See checks_naming.tf.
  vault_name          = local.azure_key_vault_name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  # Skip native Key Vault secret provisioning when a pluggable secrets provider
  # (Vault, Doppler, …) is selected — the composed module manages those instead,
  # otherwise the same secrets double-provision. The vault shell itself stays
  # (checks.tf requires vault_uri whenever AKS is up); only its contents are gated.
  secrets = var.secrets_provider == "native" ? var.custom_secrets : []

  tags = local.azure_default_tags
}
