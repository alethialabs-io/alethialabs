module "service_bus" {
  source = "./modules/service-bus"
  count  = var.create_service_bus ? 1 : 0

  location            = var.location
  environment         = var.environment
  project_name        = var.project_name
  resource_group_name = azurerm_resource_group.main.name
  sku                 = var.service_bus_sku
  queues              = var.service_bus_queues
  topics              = var.service_bus_topics

  tags = local.azure_default_tags
}
