output "kms_key_arn" {
  value       = aws_kms_key.kms_dynamodb.arn
  description = "DynamoDB KMS key arn"
}
