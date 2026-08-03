output "secret_key" {
  value = try(aws_iam_access_key.sqs[0].secret, "")
}

output "access_key" {
  value = try(aws_iam_access_key.sqs[0].id, "")
}

output "iam_role_arn" {
  value = try(aws_iam_role.sqsmq[0].arn, "")
}

# The names and the FIFO decision AS THE RESOURCES RECEIVED THEM, so a root-level test can assert
# them. `tofu test` can reach a module's outputs and nothing else inside it, and re-deriving the
# expression in the root would only assert that it equals itself — these read the planned attribute.
output "queue_names" {
  description = "Planned aws_sqs_queue name per queue key."
  value       = { for k, q in aws_sqs_queue.sqs_queue : k => q.name }
}

output "dlq_names" {
  description = "Planned aws_sqs_queue name per dead-letter queue key."
  value       = { for k, q in aws_sqs_queue.sqs_dlq : k => q.name }
}

output "queue_fifo" {
  description = "Planned fifo_queue per queue key."
  value       = { for k, q in aws_sqs_queue.sqs_queue : k => q.fifo_queue }
}

output "dlq_fifo" {
  description = "Planned fifo_queue per dead-letter queue key — must mirror the primary queue's."
  value       = { for k, q in aws_sqs_queue.sqs_dlq : k => q.fifo_queue }
}
