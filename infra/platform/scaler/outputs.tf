output "lambda_function_name" {
  description = "Scaler Lambda function name"
  value       = aws_lambda_function.scaler.function_name
}

output "lambda_function_arn" {
  description = "Scaler Lambda function ARN"
  value       = aws_lambda_function.scaler.arn
}

output "eventbridge_rule_name" {
  description = "EventBridge rule name"
  value       = aws_cloudwatch_event_rule.every_minute.name
}
