resource "azurerm_servicebus_namespace" "this" {
  name                = "${var.project_name}-${var.environment}-sb"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = var.sku

  tags = var.tags
}

resource "azurerm_servicebus_queue" "this" {
  for_each = var.queues

  name         = each.key
  namespace_id = azurerm_servicebus_namespace.this.id

  max_delivery_count = each.value.max_delivery_count
  lock_duration      = each.value.lock_duration
}

resource "azurerm_servicebus_topic" "this" {
  for_each = var.topics

  name         = each.key
  namespace_id = azurerm_servicebus_namespace.this.id
}

locals {
  topic_subscriptions = flatten([
    for topic_key, topic in var.topics : [
      for sub in topic.subscriptions : {
        key                = "${topic_key}-${sub.name}"
        topic_key          = topic_key
        name               = sub.name
        max_delivery_count = sub.max_delivery_count
      }
    ]
  ])

  topic_subscriptions_map = {
    for s in local.topic_subscriptions : s.key => s
  }
}

resource "azurerm_servicebus_subscription" "this" {
  for_each = local.topic_subscriptions_map

  name               = each.value.name
  topic_id           = azurerm_servicebus_topic.this[each.value.topic_key].id
  max_delivery_count = each.value.max_delivery_count
}
