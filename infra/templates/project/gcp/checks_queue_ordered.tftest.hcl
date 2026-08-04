# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that ordered delivery reaches google_pubsub_subscription.enable_message_ordering in BOTH
# positions, and that it lands on the SUBSCRIPTION rather than the topic (#1812).
#
# Which resource carries it is the whole design question on GCP. Pub/Sub has no queue primitive — a
# canvas queue is a topic with exactly one subscription — and ordering is a property of the
# subscription, per orderingKey. Putting it on google_pubsub_topic would be an argument that
# resource does not have; putting it on EVERY subscription would make ordering a promise about
# publishers Alethia cannot see. So a canvas queue's subscription carries the switch and a canvas
# topic's subscriptions are explicitly unordered, and both halves are pinned below.
#
# `enable_message_ordering` is ForceNew, and Pub/Sub refuses the change at the API too ("You can't
# change the message ordering property after you create a subscription"), so a wrong default
# replaces the subscription and drops its unacknowledged backlog. That is why the unordered case is
# asserted by VALUE and asserted first.
#
# Providers are mocked and the cluster is off, so this needs no credentials and runs on any PR.
# modules/**/*.tftest.hcl is silently never executed, which is why this lives at the root.

mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id   = "mock-project"
  region       = "europe-west3"
  environment  = "production"
  project_name = "alethia-nl"

  # Pub/Sub is the whole subject; everything else is off so the graph stays small enough to plan
  # without credentials.
  provision_gke               = false
  provision_artifact_registry = false
  create_cloud_sql            = false
  create_memorystore          = false
  create_memorystore_valkey   = false
  create_firestore            = false
  create_cloud_storage        = false
  cloud_dns_enabled           = false
  cloud_armor_enabled         = false

  create_pubsub = true
}

################################################################################
# The switch, in both positions
################################################################################

# The unordered case FIRST. enable_message_ordering is ForceNew, so a template that turned ordering
# on by default would replace every Pub/Sub subscription in the fleet and drop every unacknowledged
# message. Asserting the VALUE is what catches that; asserting the subscription merely plans is not.
run "an_unordered_queue_subscription_has_ordering_off" {
  command = plan

  variables {
    pubsub_topics = {
      orders = {
        message_retention_duration = "86400s"
        subscriptions = [
          { name = "orders-sub", ack_deadline_seconds = 10, enable_message_ordering = false },
        ]
      }
    }
  }

  assert {
    condition     = module.pubsub[0].subscription_message_ordering["orders-orders-sub"] == false
    error_message = "With the switch off, enable_message_ordering must be false — it is ForceNew, so a wrong default replaces every existing subscription."
  }

  assert {
    condition     = module.pubsub[0].subscription_names["orders-orders-sub"] == "alethia-nl-production-orders-sub"
    error_message = "Ordered delivery must not change a subscription's name. Got ${module.pubsub[0].subscription_names["orders-orders-sub"]}."
  }
}

# A subscription whose tfvars entry predates ordered delivery. `optional(bool, false)` on both the
# root and the module object type is what makes this plan identically to the run above.
run "a_subscription_with_no_ordering_key_at_all_has_ordering_off" {
  command = plan

  variables {
    pubsub_topics = {
      orders = {
        subscriptions = [
          { name = "orders-sub" },
        ]
      }
    }
  }

  assert {
    condition     = module.pubsub[0].subscription_message_ordering["orders-orders-sub"] == false
    error_message = "An absent enable_message_ordering key must default to false, not to whatever Pub/Sub would pick."
  }
}

# The other direction. Paired with the runs above: a template that hardcoded ordering on would pass
# this and fail those, and one that dropped the switch would pass those and fail this.
run "an_ordered_queue_subscription_has_ordering_on" {
  command = plan

  variables {
    pubsub_topics = {
      orders = {
        subscriptions = [
          { name = "orders-sub", enable_message_ordering = true },
        ]
      }
    }
  }

  assert {
    condition     = module.pubsub[0].subscription_message_ordering["orders-orders-sub"] == true
    error_message = "Ordered delivery must reach google_pubsub_subscription.enable_message_ordering — that argument is what implements it on GCP."
  }
}

################################################################################
# Per-subscription, not per-topic
################################################################################

# Two subscriptions on ONE topic, one ordered and one not. This is the assertion that proves the
# switch travels with the SUBSCRIPTION: a template that hoisted it to the topic, or that applied one
# subscription's value to all of them, passes every run above and fails this one.
run "ordering_is_decided_per_subscription_not_per_topic" {
  command = plan

  variables {
    pubsub_topics = {
      orders = {
        subscriptions = [
          { name = "ordered-consumer", enable_message_ordering = true },
          { name = "audit-consumer", enable_message_ordering = false },
        ]
      }
    }
  }

  assert {
    condition     = module.pubsub[0].subscription_message_ordering["orders-ordered-consumer"] == true
    error_message = "The ordered subscription on a shared topic must have ordering on."
  }

  assert {
    condition     = module.pubsub[0].subscription_message_ordering["orders-audit-consumer"] == false
    error_message = "An unordered subscription must stay unordered even when it shares a topic with an ordered one — ordering is a subscription property, not a topic property."
  }
}
