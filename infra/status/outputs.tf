# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "status_url" {
  description = "The public status page — the value for NEXT_PUBLIC_STATUS_URL in alethia/prod/env."
  value       = local.status_url
}

output "summary_api_url" {
  description = "The versioned public JSON (packages/status/src/state.ts SUMMARY_VERSION)."
  value       = "${local.status_url}/api/summary.json"
}

output "d1_database_id" {
  description = "The history database, for `wrangler d1 execute --remote` when inspecting it by hand."
  value       = cloudflare_d1_database.status.id
}

output "script_name" {
  description = "The Worker's name in the Cloudflare dashboard (logs, cron runs)."
  value       = cloudflare_workers_script.status.script_name
}
