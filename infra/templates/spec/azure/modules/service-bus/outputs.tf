output "namespace_id" {
  description = "The resource ID of the Service Bus namespace"
  value       = azurerm_servicebus_namespace.this.id
}

output "namespace_name" {
  description = "The name of the Service Bus namespace"
  value       = azurerm_servicebus_namespace.this.name
}

output "queue_ids" {
  description = "Map of queue names to their resource IDs"
  value = {
    for k, q in azurerm_servicebus_queue.this : k => q.id
  }
}

output "topic_ids" {
  description = "Map of topic names to their resource IDs"
  value = {
    for k, t in azurerm_servicebus_topic.this : k => t.id
  }
}
