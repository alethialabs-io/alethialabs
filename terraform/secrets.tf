resource "aws_secretsmanager_secret" "worker_token" {
  name                    = "${local.name_prefix}-worker-token"
  description             = "Grape worker authentication token"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "worker_token" {
  secret_id     = aws_secretsmanager_secret.worker_token.id
  secret_string = var.worker_token
}
