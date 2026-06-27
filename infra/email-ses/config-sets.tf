# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# One configuration set per stream. The app sends with the set name
# (ConfigurationSetName) so events are attributed per stream and routed to the
# events SNS topic. TLS is required, reputation metrics are on, and the set's
# own suppression list drops known bounces/complaints at the SES edge (the app
# keeps its own suppression table too — defense in depth).

resource "aws_sesv2_configuration_set" "stream" {
  for_each = var.streams

  configuration_set_name = "alethia-${each.key}"

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

  tags = local.tags
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  for_each = var.streams

  configuration_set_name = aws_sesv2_configuration_set.stream[each.key].configuration_set_name
  event_destination_name = "sns-events"

  event_destination {
    enabled = true
    matching_event_types = [
      "BOUNCE",
      "COMPLAINT",
      "DELIVERY",
      "REJECT",
      "RENDERING_FAILURE",
    ]

    sns_destination {
      topic_arn = aws_sns_topic.events.arn
    }
  }

  depends_on = [aws_sns_topic_policy.events]
}
