resource "azurerm_dns_zone" "this" {
  name                = var.domain
  resource_group_name = var.resource_group_name

  tags = var.tags
}
