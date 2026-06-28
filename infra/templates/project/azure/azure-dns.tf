module "azure_dns" {
  source = "./modules/azure-dns"
  count  = var.azure_dns_enabled && var.dns_provider == "native" ? 1 : 0

  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  domain              = var.azure_dns_domain
  managed_certificate = var.azure_managed_certificate

  tags = local.azure_default_tags
}
