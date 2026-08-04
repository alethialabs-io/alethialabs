locals {
  dlq_list          = { for idx, q in var.sqs_queues : idx => q if try(q.dlq_enable, false) }
  queues_with_topic = { for idx, q in var.sqs_queues : idx => q if try(q.sns_topic_name, "") != "" }

  # Ordered delivery, resolved once. `fifo_queue` is the decision the console carries; everything
  # else about FIFO on SQS is a consequence of it.
  fifo = { for k, q in var.sqs_queues : k => try(q.fifo_queue, false) }

  # SQS REFUSES a FIFO queue whose name does not end in `.fifo` — and `name` forces replacement, so
  # the suffix is a second, independent reason an ordered queue is a NEW queue rather than a changed
  # one. The unordered form is left BYTE-IDENTICAL to what it has always been ("<key>_<environment>"
  # for the queue, "<key>" for its dead-letter queue): nothing moves unless the user flips the
  # switch, and ../../checks_queue_naming.tftest.hcl pins exactly that.
  queue_names = { for k, q in var.sqs_queues : k => "${k}_${var.environment}${local.fifo[k] ? ".fifo" : ""}" }
  dlq_names   = { for k, q in local.dlq_list : k => "${k}${local.fifo[k] ? ".fifo" : ""}" }
}

## Primary Queue creation
resource "aws_sqs_queue" "sqs_queue" {
  for_each = var.sqs_queues

  name = local.queue_names[each.key]

  # Ordered (FIFO) delivery. SQS orders messages WITHIN a MessageGroupId, which the publisher must
  # set on every send — this argument buys per-key order, never a total order over the queue.
  fifo_queue = local.fifo[each.key]

  # Without this, every send to a FIFO queue must carry its own MessageDeduplicationId or SQS
  # rejects it, so a publisher that sets only a group id cannot use the queue at all. SQS refuses
  # the argument on a standard queue, which is why it tracks fifo_queue instead of standing alone.
  content_based_deduplication = try(each.value.content_based_deduplication, false)

  delay_seconds = lookup(each.value, "delay_seconds", 0)
  # The console's "Visibility timeout" field reached tfvars and no argument read it, so every queue
  # was built at the AWS default of 30s whatever the user chose (#1839).
  visibility_timeout_seconds = lookup(each.value, "visibility_timeout_seconds", 30)
  max_message_size           = lookup(each.value, "max_message_size", 262144)
  message_retention_seconds  = lookup(each.value, "message_retention_seconds", 86400)
  receive_wait_time_seconds  = lookup(each.value, "receive_wait_time_seconds", 0)

  tags = merge(var.global_tags, lookup(each.value, "tags", null))
}

# DLQ creation based on a trimmed list local.dlq_list
resource "aws_sqs_queue" "sqs_dlq" {
  for_each = local.dlq_list

  name = local.dlq_names[each.key]

  # "The dead-letter queue of a FIFO queue must also be a FIFO queue." A standard DLQ behind an
  # ordered queue is not a degraded setup — aws_sqs_queue_redrive_policy below is REJECTED by SQS,
  # so mirroring is what keeps an ordered queue appliable at all.
  fifo_queue                  = local.fifo[each.key]
  content_based_deduplication = try(each.value.content_based_deduplication, false)

  delay_seconds             = try(each.value["dlq_delay_seconds"], null)
  max_message_size          = try(each.value["dlq_max_message_size"], null)
  message_retention_seconds = try(each.value["dlq_message_retention_seconds"], null)
  receive_wait_time_seconds = try(each.value["dlq_receive_wait_time_seconds"], null)

  tags = merge(var.global_tags, lookup(each.value, "tags", null))
}

# DLQ Policy for the primary queue
resource "aws_sqs_queue_redrive_policy" "dlq_policy" {
  for_each = local.dlq_list

  queue_url = aws_sqs_queue.sqs_queue[each.key].id
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sqs_dlq[each.key].arn
    maxReceiveCount     = try(each.value["dlq_max_receive_count"], 10)
  })
}

# DLQ Allow Policy for the dlq
resource "aws_sqs_queue_redrive_allow_policy" "dlq_allow" {
  for_each = local.dlq_list

  queue_url = aws_sqs_queue.sqs_dlq[each.key].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue",
    sourceQueueArns   = [aws_sqs_queue.sqs_queue[each.key].arn]
  })
}

# SNS Topic Creation
resource "aws_sns_topic" "sns_topic" {
  for_each = var.sns_topics
  name     = "${each.key}_${var.environment}"

  fifo_topic        = lookup(each.value, "enable_fifo", false)
  kms_master_key_id = lookup(each.value, "kms_key_id", null)
  tags              = merge(var.global_tags, lookup(each.value, "tags", null))
}

resource "aws_sns_topic_subscription" "user_updates_sqs_target" {
  for_each  = local.queues_with_topic
  topic_arn = aws_sns_topic.sns_topic[each.value["sns_topic_name"]].arn

  protocol = "sqs"
  endpoint = aws_sqs_queue.sqs_queue[each.key].arn
}

resource "aws_sqs_queue_policy" "sqs_sns_policy" {
  for_each  = local.queues_with_topic
  queue_url = aws_sqs_queue.sqs_queue[each.key].id

  policy = <<POLICY
{
  "Version": "2012-10-17",
  "Id": "sqspolicy-${each.key}",
  "Statement": [
    {
      "Sid": "sqspolicy-${each.key}",
      "Effect": "Allow",
      "Principal": {
        "Service": "sns.amazonaws.com"
      },
      "Action": "sqs:SendMessage",
      "Resource": "${aws_sqs_queue.sqs_queue[each.key].arn}"
    }
  ]
}
POLICY
}
