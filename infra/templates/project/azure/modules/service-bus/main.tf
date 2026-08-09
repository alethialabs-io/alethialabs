resource "azurerm_servicebus_namespace" "this" {
  # Azure REJECTS a Service Bus namespace whose name ends with "-sb" (also "-mgmt", or a hyphen):
  #   Error: "name" cannot end with a hyphen, -sb, or -mgmt
  # The old "${project}-${environment}-sb" therefore made Service Bus — i.e. the queue AND topic
  # kinds — impossible to create. Lead with the discriminator instead of trailing it.
  # Derived at the template root (checks_naming.tf, local.azure_service_bus_name) — see the
  # NAMING-002 note there. The readable "sb-<project_name>-<environment>" form is preserved.
  name                = var.namespace_name
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

  # How long an unconsumed message survives (#1994). null leaves Azure's default in place.
  default_message_ttl = each.value.default_message_ttl

  # Ordered delivery. A session-enabled queue hands every message sharing one SessionId to a single
  # receiver, in arrival order. `requires_session` FORCES REPLACEMENT of the queue, and once it is
  # on, clients can no longer send or receive plain messages — both are day-2 hazards, which is why
  # azurerm_servicebus_queue is in test/e2e/t2_day2_offer.go's day2StatefulTypes.
  requires_session = each.value.requires_session
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
