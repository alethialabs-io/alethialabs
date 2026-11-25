// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProjectListItem } from "@/app/server/actions/projects";
import type { ProjectsPage } from "@/lib/queries/projects";
import type { OverviewProjectsSummary } from "@/lib/rpc/procedures/overview";

/**
 * A complete overview grid row for tests: an AWS project named `name`, with a default environment
 * that is ACTIVE. Typed as `ProjectListItem` with no cast, so a schema change that drops or renames
 * a column fails the build here too. Override any field per case.
 */
export function makeProject(id: string, name: string, overrides: Partial<ProjectListItem> = {}): ProjectListItem {
	const at = new Date("2026-10-01T00:00:00.000Z");
	return {
		id,
		user_id: "00000000-0000-4000-8000-000000000001",
		org_id: "00000000-0000-4000-8000-000000000002",
		cloud_identity_id: null,
		project_name: name,
		slug: name,
		region: "eu-central-1",
		iac_version: "1",
		estimated_monthly_cost: null,
		webhook_ca_consumers: [],
		created_at: at,
		updated_at: at,
		cloud_provider: "aws",
		environment_stage: "production",
		status: "ACTIVE",
		default_environment_id: null,
		repositories: [],
		services_count: 0,
		addons_count: 0,
		environments_count: 1,
		last_deployed_at: null,
		...overrides,
	};
}

/**
 * One page of the grid's walk (`overview.projects.page`) holding `rows`: the LAST page unless a
 * `nextCursor` is given, and a first page (facets, `universeEmpty`) unless overridden.
 */
export function makePage(rows: ProjectListItem[], overrides: Partial<ProjectsPage> = {}): ProjectsPage {
	return {
		rows,
		nextCursor: null,
		facets: { clouds: [], repos: [] },
		universeEmpty: rows.length === 0,
		...overrides,
	};
}

/**
 * The grid's summary (`overview.projects.summary`): AWS connected, the four offered clouds, a viewer
 * who may create a project. Override any field per case.
 */
export function makeSummary(overrides: Partial<OverviewProjectsSummary> = {}): OverviewProjectsSummary {
	return {
		projectCount: 1,
		connectedProviders: ["aws"],
		offeredClouds: ["aws", "gcp", "azure", "hetzner"],
		canCreate: true,
		...overrides,
	};
}
