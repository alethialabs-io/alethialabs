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
