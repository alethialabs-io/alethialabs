# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# One configuration set per stream, identical to infra/email-ses/config-sets.tf. The app sends with
# the set name (ConfigurationSetName), so events are attributed per stream and routed to the events
# SNS topic. TLS is required, reputation metrics are on, and the set's own suppression list drops
# known bounces and complaints at the SES edge. The app keeps its own suppression table as well.

resource "aws_sesv2_configuration_set" "stream" {
  for_each = local.streams

  configuration_set_name = local.config_set_names[each.key]

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  for_each = local.streams

  configuration_set_name = aws_sesv2_configuration_set.stream[each.key].configuration_set_name
  event_destination_name = "sns-events"

  event_destination {
    enabled              = true
    matching_event_types = local.event_types

    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }

  # SES publishes a plain-text "Successfully validated SNS topic for Amazon SES event publishing"
  # message to the topic when the destination is created, so the topic policy that lets it publish
  # and the key policy that lets it encrypt must exist first. The webhook acknowledges that message
  # without acting on it.
  depends_on = [aws_sns_topic_policy.events, aws_kms_key.sns]
}
