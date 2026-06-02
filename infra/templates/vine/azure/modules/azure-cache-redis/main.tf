resource "azurerm_redis_cache" "this" {
  name                = "${var.project_name}-${var.environment}-redis"
  location            = var.location
  resource_group_name = var.resource_group_name
  capacity            = var.capacity
  family              = var.family
  sku_name            = var.sku
  minimum_tls_version = "1.2"
  redis_version       = var.redis_version
  zones               = var.multi_az ? ["1", "2", "3"] : []
  subnet_id           = var.subnet_id != "" ? var.subnet_id : null

  tags = var.tags
}
