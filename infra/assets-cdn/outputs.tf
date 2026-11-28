# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "assets_url" {
  description = "The public base URL. Apps read it as NEXT_PUBLIC_ASSETS_URL (apps/marketing/lib/assets.ts)."
  value       = "https://${cloudflare_r2_custom_domain.assets.domain}"
}

output "bucket_name" {
  description = "The R2 bucket to upload into (README.md, \"Uploading\")."
  value       = cloudflare_r2_bucket.assets.name
}

output "bucket_jurisdiction" {
  description = "Uploads to an EU-jurisdiction bucket must use the EU endpoint (README.md, \"Uploading\")."
  value       = cloudflare_r2_bucket.assets.jurisdiction
}
