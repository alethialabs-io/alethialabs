resource "azurerm_dns_zone" "this" {
  name                = var.domain
  resource_group_name = var.resource_group_name

  tags = var.tags
}

resource "azurerm_app_service_certificate_order" "this" {
  count               = var.managed_certificate ? 1 : 0
  name                = "${var.project_name}-${var.environment}-cert"
  resource_group_name = var.resource_group_name
  location            = "global"
  distinguished_name  = "CN=*.${var.domain}"
  product_type        = "WildcardSsl"

  tags = var.tags
}
