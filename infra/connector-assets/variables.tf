# SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "aws_region" {
  description = "Region the connector-assets bucket lives in (its segment of the public asset URL — keep in sync with NEXT_PUBLIC_CONNECTOR_ASSETS_ORIGIN and the CLI connectorBaseURL)."
  type        = string
  default     = "eu-west-1"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket holding the public connector setup artifacts."
  type        = string
  default     = "alethia-connector-assets"
}
