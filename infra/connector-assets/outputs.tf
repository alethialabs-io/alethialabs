# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "bucket_name" {
  description = "Name of the connector-assets bucket."
  value       = aws_s3_bucket.assets.bucket
}

output "assets_base_url" {
  description = "Public base URL — must match NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN's default and the CLI connectorBaseURL."
  value       = "https://${aws_s3_bucket.assets.bucket}.s3.${var.aws_region}.amazonaws.com"
}
