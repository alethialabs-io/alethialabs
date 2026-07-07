# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

output "integration_branch" {
  description = "The created integration branch."
  value       = github_branch.dev.branch
}

output "main_ruleset_id" {
  description = "ID of the main protection ruleset."
  value       = github_repository_ruleset.main.id
}

output "staging_ruleset_id" {
  description = "ID of the staging protection ruleset."
  value       = github_repository_ruleset.staging.id
}
