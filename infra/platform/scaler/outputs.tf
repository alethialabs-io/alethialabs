output "lambda_function_name" {
  description = "Scaler Lambda function name"
  value       = aws_lambda_function.scaler.function_name
}

output "lambda_function_arn" {
  description = "Scaler Lambda function ARN"
  value       = aws_lambda_function.scaler.arn
}

output "scaler_function_url" {
  description = "Scaler Lambda function URL (for direct invoke from Vertex)"
  value       = aws_lambda_function_url.scaler.function_url
}

output "eventbridge_rule_name" {
  description = "EventBridge rule name"
  value       = aws_cloudwatch_event_rule.every_minute.name
}
