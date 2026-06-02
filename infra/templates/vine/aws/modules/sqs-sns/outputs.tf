output "secret_key" {
  value = try(aws_iam_access_key.sqs[0].secret, "")
}

output "access_key" {
  value = try(aws_iam_access_key.sqs[0].id, "")
}

output "iam_role_arn" {
  value = try(aws_iam_role.sqsmq[0].arn, "")
}
