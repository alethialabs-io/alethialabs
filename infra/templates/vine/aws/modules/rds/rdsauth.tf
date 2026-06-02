# KMS key
resource "aws_kms_key" "rds_secret_kms_key" {
  description         = "KMS key to be used to encrypt the RDS secret values"
  enable_key_rotation = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Full Access for root account"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.aws_account_id}:root"
        }
        Action   = ["kms:*"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "rds_secret_kms_key_alias" {
  name          = "alias/${local.name_string}_rds_secret_key"
  target_key_id = aws_kms_key.rds_secret_kms_key.key_id
}

# Master RDS credentials
resource "random_password" "dbpass" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "dbsecret" {
  description = "RDS Master credentials"
  name        = "rds-${local.name_string}"
  kms_key_id  = aws_kms_key.rds_secret_kms_key.arn
  tags        = var.rds_tags

  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "dbsecret_version" {
  secret_id     = aws_secretsmanager_secret.dbsecret.id
  secret_string = <<EOF
  {
    "username": "${var.rds_default_username}",
    "password": "${random_password.dbpass.result}"
  }
EOF
}

# Extra RDS credentials
resource "random_password" "dbpass_extra" {
  length  = 32
  special = false

  count = var.rds_extra_credentials.password == null ? 1 : 0
}

resource "aws_secretsmanager_secret" "dbsecret_extra" {
  description = "RDS Extra credentials"
  name        = "rds-${local.name_string}-extra"
  kms_key_id  = aws_kms_key.rds_secret_kms_key.arn
  tags        = var.rds_tags
  
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "dbsecret_extra_version" {
  secret_id = aws_secretsmanager_secret.dbsecret_extra.id
  secret_string = jsonencode({
    username = var.rds_extra_credentials.username
    password = coalesce(var.rds_extra_credentials.password, random_password.dbpass_extra[0].result)
    database = var.rds_extra_credentials.database
  })
}

### Read secret
#data "aws_secretsmanager_secret" "dbsecret" {
#  arn = aws_secretsmanager_secret.dbsecret.arn
#}
#
#data "aws_secretsmanager_secret_version" "rds_creds" {
#  secret_id = data.aws_secretsmanager_secret.dbsecret.arn
#}
