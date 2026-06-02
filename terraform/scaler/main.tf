terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------- Lambda function ----------

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/lambda.zip"
}

resource "aws_lambda_function" "scaler" {
  function_name    = "${var.name_prefix}-scaler"
  description      = "Scale ECS tendrils based on queued provision jobs"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  handler          = "index.handler"
  runtime          = "python3.12"
  timeout          = 30
  memory_size      = 128

  role = aws_iam_role.scaler.arn

  environment {
    variables = {
      SUPABASE_URL              = var.supabase_url
      SUPABASE_SERVICE_ROLE_KEY = var.supabase_service_role_key
      WORKERS                   = jsonencode(var.workers)
    }
  }
}

# ---------- EventBridge rule (every 1 minute) ----------

resource "aws_cloudwatch_event_rule" "every_minute" {
  name                = "${var.name_prefix}-scaler-tick"
  description         = "Trigger scale-to-zero check every minute"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "scaler" {
  rule      = aws_cloudwatch_event_rule.every_minute.name
  target_id = "scaler-lambda"
  arn       = aws_lambda_function.scaler.arn
}

resource "aws_lambda_permission" "eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scaler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.every_minute.arn
}

# ---------- IAM role for Lambda ----------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scaler" {
  name               = "${var.name_prefix}-scaler"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "scaler_basic" {
  role       = aws_iam_role.scaler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "scaler_ecs" {
  name = "ecs-scale"
  role = aws_iam_role.scaler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices",
        ]
        Resource = "*"
      }
    ]
  })
}

# ---------- CloudWatch log group for Lambda ----------

resource "aws_cloudwatch_log_group" "scaler" {
  name              = "/aws/lambda/${var.name_prefix}-scaler"
  retention_in_days = 14
}
