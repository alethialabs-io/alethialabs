// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
	cloudIdentities,
	jobLogs,
	jobs,
	runners,
	specCluster,
	specs,
	zones,
} from "@/lib/db/schema";
import { cloudProvider } from "@/lib/db/schema/enums";

/**
 * The CLI wire contract — the single source of truth for every JSON shape the
 * `alethia` CLI decodes. The Go structs in packages/core/api are mirrors of
 * these schemas; drift between the two is what this file (plus cliJson and the
 * Go contract tests) exists to make impossible.
 *
 * Schemas model the POST-serialization wire: timestamps are ISO strings (Drizzle
 * Date objects become strings through JSON.stringify before they reach the
 * client), so cliJson validates exactly the bytes that go out and z.toJSONSchema
 * can emit these without choking on z.date().
 */

// ISO-8601 timestamps as they appear on the wire.
const iso = z.iso.datetime({ offset: true });
const isoNullable = iso.nullable();

// Open JSON object (jsonb columns whose shape is polymorphic on the wire).
const jsonObject = z.record(z.string(), z.unknown());

// --- Element schemas ---

/** A runner row as returned by GET /api/cli/runners. */
export const runnerWire = createSelectSchema(runners, {
	created_at: iso,
	last_heartbeat: isoNullable,
}).pick({
	id: true,
	name: true,
	operator: true,
	provisioning: true,
	supported_providers: true,
	status: true,
	last_heartbeat: true,
	version: true,
	is_default: true,
	created_at: true,
});

/** A spec as nested under a zone in GET /api/cli/zones. */
export const zoneSpecWire = createSelectSchema(specs).pick({
	id: true,
	project_name: true,
	environment_stage: true,
	status: true,
	region: true,
});

/** A zone with its nested specs (GET /api/cli/zones). */
export const zoneWire = createSelectSchema(zones, {
	created_at: iso,
	updated_at: iso,
})
	.pick({
		id: true,
		user_id: true,
		name: true,
		description: true,
		created_at: true,
		updated_at: true,
	})
	.extend({ specs: z.array(zoneSpecWire) });

/** A full zone row (POST /api/cli/zones returns the created zone). */
export const zoneFullWire = createSelectSchema(zones, {
	created_at: iso,
	updated_at: iso,
}).pick({
	id: true,
	user_id: true,
	org_id: true,
	name: true,
	description: true,
	created_at: true,
	updated_at: true,
});

/** A spec_cluster row joined with its parent spec (GET /api/cli/clusters). */
export const clusterWire = createSelectSchema(specCluster, {
	created_at: iso,
	updated_at: iso,
})
	.pick({
		id: true,
		cluster_name: true,
		cluster_version: true,
		instance_types: true,
		node_min_size: true,
		node_max_size: true,
		node_desired_size: true,
		status: true,
		status_message: true,
		argocd_url: true,
		estimated_monthly_cost: true,
		created_at: true,
		updated_at: true,
	})
	.extend({
		spec_project_name: z.string(),
		spec_environment: z.string(),
		spec_region: z.string(),
	});

/** A cloud identity (GET /api/cli/cloud-identities). `label` is computed. */
export const cloudIdentityWire = createSelectSchema(cloudIdentities, {
	created_at: iso,
})
	.pick({ id: true, provider: true, created_at: true })
	.extend({ label: z.string() });

/** A job row. Returned bare by GET /api/cli/jobs/:id and inside envelopes. */
export const jobWire = createSelectSchema(jobs, {
	claimed_at: isoNullable,
	started_at: isoNullable,
	completed_at: isoNullable,
	created_at: iso,
	updated_at: iso,
	config_snapshot: jsonObject,
	execution_metadata: jsonObject.nullable(),
}).omit({
	// Internal scheduling/billing columns — stripped by cliJson, never on the CLI wire.
	requires_self_runner: true,
	usage_reported_at: true,
});

/** A job as returned in the list (GET /api/jobs) — adds joined display names. */
export const jobListItemWire = jobWire.extend({
	spec_name: z.string().nullable(),
	runner_name: z.string().nullable(),
});

/** A job log line (GET /api/cli/jobs/:id/logs). */
export const jobLogWire = createSelectSchema(jobLogs, {
	created_at: iso,
}).pick({
	id: true,
	job_id: true,
	log_chunk: true,
	stream_type: true,
	created_at: true,
});

/** A git repository (GET /api/cli/repositories/:provider). */
export const repositoryWire = z.object({
	id: z.string(),
	name: z.string(),
	full_name: z.string(),
	url: z.string(),
	private: z.boolean(),
	default_branch: z.string(),
	provider: z.string(),
});

/** Verified provider connection status (GET /api/cli/providers/:provider/status).
 * Hand-written (no backing table) with camelCase keys, as conn.getStatus emits. */
export const providerStatusWire = z.object({
	connected: z.boolean(),
	identityId: z.string().nullable().optional(),
	accountId: z.string().nullable().optional(),
	roleArn: z.string().nullable().optional(),
	externalId: z.string().nullable().optional(),
	projectId: z.string().nullable().optional(),
	serviceAccountEmail: z.string().nullable().optional(),
	tenantId: z.string().nullable().optional(),
	clientId: z.string().nullable().optional(),
	subscriptionId: z.string().nullable().optional(),
});

/** Pending-identity init (POST /api/cli/providers/:provider/init). */
export const initIdentityWire = z.object({
	identity_id: z.string(),
	external_id: z.string().nullable().optional(),
});

/** Credential submission (POST /api/cli/providers/:provider/connect). */
export const connectIdentityWire = z.object({
	job_id: z.string(),
	identity_id: z.string(),
});

/** Deploy-runner result (POST /api/cli/runners/deploy). */
export const deployRunnerWire = z.object({
	runner: z.object({ id: z.string(), name: z.string() }),
	job: z.object({
		id: z.string(),
		status: z.string(),
		created_at: iso,
	}),
});

/** Latest published CLI release (GET /api/releases/cli) — drives the update notice. */
export const cliLatestReleaseWire = z.object({
	version: z.string(),
	release_notes: z.string(),
	released_at: iso,
	github_release_url: z.string().nullable(),
	min_supported_version: z.string().nullable(),
});

// --- Response envelopes (what the CLI actually decodes off the wire) ---

export const cliRunnersResponse = z.object({ runners: z.array(runnerWire) });
export const cliZonesResponse = z.object({ zones: z.array(zoneWire) });
export const cliZoneResponse = z.object({ zone: zoneFullWire });
export const cliClustersResponse = z.object({ clusters: z.array(clusterWire) });
export const cliCloudIdentitiesResponse = z.object({
	cloud_identities: z.array(cloudIdentityWire),
});
export const cliJobsPageResponse = z.object({
	jobs: z.array(jobListItemWire),
	total: z.number().int(),
	limit: z.number().int(),
	offset: z.number().int(),
});
export const cliJobResponse = z.object({ job: jobWire });
export const cliJobLogsResponse = z.object({ logs: z.array(jobLogWire) });
export const cliRepositoriesResponse = z.object({
	repositories: z.array(repositoryWire),
});

/**
 * The registry of every CLI contract schema, keyed by a stable name. cliJson
 * callers reference these directly; the A2 codegen step enumerates this map to
 * emit one Go type per entry. Keep the keys in sync with the Go struct names.
 */
export const cliContract = {
	RunnersResponse: cliRunnersResponse,
	ZonesResponse: cliZonesResponse,
	ZoneResponse: cliZoneResponse,
	ClustersResponse: cliClustersResponse,
	CloudIdentitiesResponse: cliCloudIdentitiesResponse,
	JobsPageResponse: cliJobsPageResponse,
	JobResponse: cliJobResponse,
	Job: jobWire,
	JobLogsResponse: cliJobLogsResponse,
	RepositoriesResponse: cliRepositoriesResponse,
	ProviderStatus: providerStatusWire,
	InitIdentity: initIdentityWire,
	ConnectIdentity: connectIdentityWire,
	DeployRunnerResponse: deployRunnerWire,
	LatestRelease: cliLatestReleaseWire,
} as const;

export type CliContract = typeof cliContract;
