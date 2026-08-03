output "topic_ids" {
  description = "Map of topic keys to their full resource IDs"
  value = {
    for key, topic in google_pubsub_topic.this : key => topic.id
  }
}

output "subscription_ids" {
  description = "Map of subscription keys to their full resource IDs"
  value = {
    for key, sub in google_pubsub_subscription.this : key => sub.id
  }
}

# The planned attribute, so a root-level test can assert what the RESOURCE received rather than
# restate the expression that produced it. `tofu test` can reach a module's outputs and nothing else
# inside it, and modules/**/*.tftest.hcl is silently never executed.
output "subscription_message_ordering" {
  description = "Planned enable_message_ordering per subscription key."
  value = {
    for key, sub in google_pubsub_subscription.this : key => sub.enable_message_ordering
  }
}

output "subscription_names" {
  description = "Planned google_pubsub_subscription name per subscription key."
  value = {
    for key, sub in google_pubsub_subscription.this : key => sub.name
  }
}
