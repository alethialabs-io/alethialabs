// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { JobWithMeta } from "@/app/server/actions/jobs";

/**
 * Builds a complete `JobWithMeta` row for tests — a DEPLOY job scoped to "web · production"
 * by default. Override any field per case. Typed as `JobWithMeta` (no casts) so a schema
 * change that drops/renames a column fails the build here too.
 */
export function makeJob(overrides: Partial<JobWithMeta> = {}): JobWithMeta {
	return {
		id: "job-1",
		user_id: "user-1",
		org_id: null,
		project_id: "proj-1",
		environment_id: "env-1",
		cloud_identity_id: null,
		job_type: "DEPLOY",
		config_snapshot: {},
		configuration_hash: null,
		status: "QUEUED",
		priority: 0,
		provider: null,
		requires_self_runner: false,
		runner_id: null,
		assigned_runner_id: null,
		plan_job_id: null,
		claimed_at: null,
		started_at: null,
		completed_at: null,
		usage_reported_at: null,
		error_message: null,
		execution_metadata: null,
		verify_override: null,
		created_at: new Date("2026-06-30T00:00:00.000Z"),
		updated_at: new Date("2026-06-30T00:00:00.000Z"),
		project_name: "web",
		project_slug: "web",
		runner_name: null,
		cloud_provider: null,
		environment_name: "production",
		environment_stage: null,
		...overrides,
	};
}
