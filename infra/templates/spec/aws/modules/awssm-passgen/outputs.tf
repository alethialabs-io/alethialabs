output "secret_arns" {
  description = "ARNs of the created secrets in AWS Secrets Manager."
  value       = { for secret in var.custom_secrets : secret.secret_name => aws_secretsmanager_secret.secret[secret.secret_name].arn }
}

output "secret_names" {
  description = "Names of the created secrets in AWS Secrets Manager."
  value       = { for secret in var.custom_secrets : secret.secret_name => aws_secretsmanager_secret.secret[secret.secret_name].name }
}

output "secret_versions" {
  description = "The versions of the created secrets in AWS Secrets Manager."
  value       = { for secret in var.custom_secrets : secret.secret_name => aws_secretsmanager_secret_version.version[secret.secret_name].version_id }
}

output "secret_values" {
  description = "The values of the created secrets. Sensitive information."
  value       = { for secret in var.custom_secrets : secret.secret_name => try(random_password.password[secret.secret_name].result, "editme") }
  sensitive   = true
}
