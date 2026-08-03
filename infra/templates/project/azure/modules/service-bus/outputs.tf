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

# The planned attribute, so a root-level test can assert what the RESOURCE received rather than
# restate the expression that produced it. `tofu test` can reach a module's outputs and nothing else
# inside it, and modules/**/*.tftest.hcl is silently never executed.
output "queue_requires_session" {
  description = "Planned requires_session per queue name."
  value = {
    for k, q in azurerm_servicebus_queue.this : k => q.requires_session
  }
}

output "queue_names" {
  description = "Planned azurerm_servicebus_queue name per queue key."
  value = {
    for k, q in azurerm_servicebus_queue.this : k => q.name
  }
}
