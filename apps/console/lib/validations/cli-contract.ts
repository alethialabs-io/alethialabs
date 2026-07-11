// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
	cloudIdentities,
	jobLogs,
	jobs,
	runners,
	projectCluster,
	projects,
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


/** A project_cluster row joined with its parent project (GET /api/cli/clusters). */
export const clusterWire = createSelectSchema(projectCluster, {
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
		project_name: z.string(),
		environment: z.string(),
		region: z.string(),
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
	// M1: per-environment provisioning target — internal, not on the frozen CLI wire.
	environment_id: true,
	// Internal elench waiver input (set by console authz) — never on the CLI wire.
	verify_override: true,
});

/** A job as returned in the list (GET /api/jobs) — adds joined display names. */
export const jobListItemWire = jobWire.extend({
	project_name: z.string().nullable(),
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

/** Credential submission (POST /api/cli/providers/:provider/connect). The server
 * verifies the identity INLINE (synchronous health probe) and returns the verdict
 * directly — there is no CONNECTION_TEST job to poll anymore. */
export const connectIdentityWire = z.object({
	identity_id: z.string(),
	verified: z.boolean(),
	status: z.enum(["connected", "degraded", "disconnected"]),
	error: z.string().nullable(),
	missing_permissions: z.array(z.string()),
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

/** An organization the caller belongs to (GET /api/cli/orgs, whoami.active_org).
 * Hand-written wire (no single backing table — joins org + member + billing). */
export const orgWire = z.object({
	id: z.uuid(),
	name: z.string(),
	slug: z.string(),
	role: z.string(),
	plan: z.string(),
	is_active: z.boolean(),
});

/** The resolved CLI identity (GET /api/cli/whoami). `active_org` / `default_runner`
 * are null when the caller has no active org / no default runner. */
export const whoamiWire = z.object({
	user: z.object({ id: z.uuid(), email: z.string(), name: z.string() }),
	active_org: orgWire.nullable(),
	default_runner: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});

/** A member of an org (GET /api/cli/orgs/:id/members). `email`/`name` joined from user. */
export const memberWire = z.object({
	id: z.uuid(),
	user_id: z.uuid(),
	email: z.string(),
	name: z.string(),
	role: z.string(),
	status: z.string(),
});

/** A pending invitation (POST /api/cli/orgs/:id/members). */
export const invitationWire = z.object({
	id: z.uuid(),
	email: z.string(),
	role: z.string(),
	status: z.string(),
});

/** A team in an org (GET/POST /api/cli/orgs/:id/teams). */
export const teamWire = z.object({
	id: z.uuid(),
	name: z.string(),
	member_count: z.number().int(),
});

/** A notification channel (GET/POST /api/cli/channels). The encrypted secret
 * envelope is never on the wire; only whether one is configured + the email
 * recipients. Mirrors the `alert_channels` table, client-safe like ChannelDTO. */
export const channelWire = z.object({
	id: z.uuid(),
	type: z.string(),
	name: z.string(),
	enabled: z.boolean(),
	is_verified: z.boolean(),
	recipients: z.array(z.string()),
	has_secret: z.boolean(),
	last_verified_at: isoNullable,
	created_at: iso,
});

/** An alert rule (GET/POST /api/cli/alerts). Binds a set of event-key patterns to
 * notification channels; `channel_ids` are the bound channels. Mirrors `alert_rules`
 * + its `alert_rule_channels` bindings. */
export const alertRuleWire = z.object({
	id: z.uuid(),
	name: z.string(),
	description: z.string().nullable(),
	event_patterns: z.array(z.string()),
	severity: z.string(),
	throttle_seconds: z.number().int(),
	enabled: z.boolean(),
	channel_ids: z.array(z.uuid()),
	created_at: iso,
});

/** A delivery/activity log entry (GET /api/cli/activity). The PDP-written
 * `authz_activity_log`, joined to the acting user. `id` is the bigint serialized
 * as a string (matches the console ActivityRow shape). */
export const activityWire = z.object({
	id: z.string(),
	actor_id: z.uuid(),
	actor_name: z.string().nullable(),
	actor_email: z.string().nullable(),
	action: z.string(),
	resource_type: z.string(),
	resource_id: z.string().nullable(),
	decision: z.boolean(),
	reason: z.string().nullable(),
	ts: iso,
});

/** A role (GET/POST /api/cli/roles). Built-ins are org-wide templates (is_builtin),
 * custom roles are org-scoped. `permission_keys` are the role's `resource:action`
 * keys. Mirrors `role` + its `role_permission` rows (registry-as-code for built-ins). */
export const roleWire = z.object({
	id: z.uuid(),
	name: z.string(),
	description: z.string().nullable(),
	is_builtin: z.boolean(),
	permission_keys: z.array(z.string()),
});

/** An access grant (GET/POST /api/cli/grants). Binds a principal (user/team) to a
 * role OR a single permission, at a resource scope, as an allow or explicit deny.
 * `role` is the bound role's name (null for a single-permission grant);
 * `permission_key` is the bound permission (null for a role grant); `resource_id`
 * null = org-wide. Mirrors the `grants` table joined to `role`. */
export const grantWire = z.object({
	id: z.uuid(),
	principal_type: z.string(),
	principal_id: z.uuid(),
	effect: z.string(),
	role: z.string().nullable(),
	permission_key: z.string().nullable(),
	resource_type: z.string(),
	resource_id: z.uuid().nullable(),
});

/** An SSO identity provider (GET /api/cli/sso). Secrets / oidc+saml config JSON are
 * never on the wire; only the provider type (oidc|saml), the claimed domain, the
 * issuer, and whether it is enabled (its domain is verified). Mirrors `sso_provider`. */
export const ssoProviderWire = z.object({
	id: z.uuid(),
	provider_type: z.string(),
	domain: z.string(),
	issuer: z.string(),
	enabled: z.boolean(),
});

/** The active org's billing state (GET /api/cli/billing). A minimal, client-safe view of
 * the `organization_billing` row joined with the plan catalog: the resolved plan/status,
 * the purchased seat count (null on flat tiers / no subscription), the Stripe subscription
 * id, and the trial / current-period boundaries. No Stripe customer ids or amounts. */
export const billingWire = z.object({
	plan: z.string(),
	status: z.string(),
	seats: z.number().int().nullable(),
	stripe_subscription_id: z.string().nullable(),
	trial_ends_at: isoNullable,
	current_period_end: isoNullable,
});

/** The active org's current usage (GET /api/cli/usage): billable seats used vs the
 * purchased cap, managed-runner minutes consumed this period, the project count, and the
 * AI credits used vs the plan's weekly grant. All counters; never timestamps. */
export const usageWire = z.object({
	seats_used: z.number().int(),
	seats_cap: z.number().int(),
	runner_minutes: z.number().int(),
	projects: z.number().int(),
	ai_credits_used: z.number().int(),
	ai_credits_granted: z.number().int(),
});

/** A managed-fleet warm pool (GET /api/cli/fleet, PUT /api/cli/fleet/:provider). Mirrors
 * the GLOBAL `fleet_pools` config (no org_id — platform-operator infrastructure): the
 * target cloud, the warm floor / hard ceiling / slots, the spread locations, surge +
 * buffer headroom, the pinned version XOR release channel, and whether it is enabled. */
export const fleetPoolWire = z.object({
	provider: z.string(),
	warm_min: z.number().int(),
	max: z.number().int(),
	slots_per_runner: z.number().int(),
	locations: z.array(z.string()),
	surge: z.number().int(),
	buffer: z.number().int(),
	channel: z.string().nullable(),
	version: z.string().nullable(),
	enabled: z.boolean(),
});

/** A project as returned by POST /api/cli/projects (authoring). Reuses the frozen
 * project columns plus the default-environment-derived `environment_stage` / `status`
 * and the resolved `cloud_provider` (the identity's provider, "" when unlinked). */
export const projectWire = z.object({
	id: z.uuid(),
	project_name: z.string(),
	slug: z.string(),
	region: z.string(),
	iac_version: z.string(),
	cloud_identity_id: z.string().nullable(),
	cloud_provider: z.string(),
	environment_stage: z.string(),
	status: z.string(),
	estimated_monthly_cost: z.number().nullable(),
	created_at: iso,
	updated_at: iso,
});

/** A project environment (GET/POST /api/cli/projects/:id/environments). One row per
 * deployment target; `is_default` marks the project's anchor env. `region` null inherits
 * the project's region. Mirrors `project_environments`. */
export const environmentWire = z.object({
	id: z.uuid(),
	name: z.string(),
	stage: z.string(),
	status: z.string(),
	is_default: z.boolean(),
	region: z.string().nullable(),
});

/** A project component (GET /api/cli/projects/:id/components, POST .../components/:kind).
 * One uniform shape across all 13 component kinds (network/cluster/dns/observability/
 * repositories singletons + databases/caches/queues/topics/nosql_tables/
 * container_registries/secrets/storage_buckets). `config` is the kind-specific column set
 * as an open object (shapes vary by kind), so a SINGLE Go struct decodes every kind.
 * `cloud_identity_id` null = inherit the project's primary identity. */
export const componentWire = z.object({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	status: z.string(),
	cloud_identity_id: z.string().nullable(),
	config: jsonObject,
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
export const cliOrgsResponse = z.object({ orgs: z.array(orgWire) });
export const cliMembersResponse = z.object({ members: z.array(memberWire) });
export const cliTeamsResponse = z.object({ teams: z.array(teamWire) });
/** POST /api/cli/orgs/:id/members result. */
export const cliInvitationResponse = z.object({ invitation: invitationWire });
/** POST /api/cli/orgs/:id/teams result. */
export const cliTeamResponse = z.object({ team: teamWire });
/** GET /api/cli/channels result. */
export const cliChannelsResponse = z.object({ channels: z.array(channelWire) });
/** POST /api/cli/channels + POST /api/cli/channels/:id/verify result. */
export const cliChannelResponse = z.object({ channel: channelWire });
/** GET /api/cli/alerts result. */
export const cliAlertRulesResponse = z.object({
	alert_rules: z.array(alertRuleWire),
});
/** POST /api/cli/alerts result. */
export const cliAlertRuleResponse = z.object({ alert_rule: alertRuleWire });
/** GET /api/cli/activity result. */
export const cliActivityResponse = z.object({ activity: z.array(activityWire) });
/** GET /api/cli/roles result. */
export const cliRolesResponse = z.object({ roles: z.array(roleWire) });
/** POST /api/cli/roles result. */
export const cliRoleResponse = z.object({ role: roleWire });

/** A classification dimension + its values (GET /api/cli/classification/dimensions). */
export const classificationDimensionWire = z.object({
	id: z.uuid(),
	key: z.string(),
	label: z.string(),
	description: z.string().nullable(),
	multi: z.boolean(),
	/** Resource kinds this dimension applies to; empty ⇒ all. */
	applies_to: z.array(z.string()),
	values: z.array(
		z.object({ id: z.uuid(), value: z.string(), label: z.string() }),
	),
});
export const cliClassificationDimensionsResponse = z.object({
	dimensions: z.array(classificationDimensionWire),
});

/** A value assigned to a resource (GET/POST /api/cli/classification/assignments). */
export const classificationAssignmentWire = z.object({
	dimension_key: z.string(),
	dimension_label: z.string(),
	value: z.string(),
	value_label: z.string(),
});
export const cliClassificationAssignmentsResponse = z.object({
	assignments: z.array(classificationAssignmentWire),
});
/** GET /api/cli/grants result. */
export const cliGrantsResponse = z.object({ grants: z.array(grantWire) });
/** POST /api/cli/grants result. */
export const cliGrantResponse = z.object({ grant: grantWire });
/** GET /api/cli/sso result. */
export const cliSsoProvidersResponse = z.object({
	sso_providers: z.array(ssoProviderWire),
});
/** GET /api/cli/sso/:id result. */
export const cliSsoProviderResponse = z.object({ sso_provider: ssoProviderWire });
/** GET /api/cli/billing result. */
export const cliBillingResponse = z.object({ billing: billingWire });
/** GET /api/cli/usage result. */
export const cliUsageResponse = z.object({ usage: usageWire });
/** GET /api/cli/fleet result. */
export const cliFleetPoolsResponse = z.object({ pools: z.array(fleetPoolWire) });
/** PUT /api/cli/fleet/:provider result. */
export const cliFleetPoolResponse = z.object({ pool: fleetPoolWire });
/** POST /api/cli/projects result. */
export const cliProjectResponse = z.object({ project: projectWire });
/** GET /api/cli/projects/:id/environments result. */
export const cliEnvironmentsResponse = z.object({
	environments: z.array(environmentWire),
});
/** POST /api/cli/projects/:id/environments result. */
export const cliEnvironmentResponse = z.object({ environment: environmentWire });
/** GET /api/cli/projects/:id/components result. */
export const cliComponentsResponse = z.object({
	components: z.array(componentWire),
});
/** POST /api/cli/projects/:id/components/:kind result. */
export const cliComponentResponse = z.object({ component: componentWire });
/** DELETE member/team/channel/alert/role/grant result. */
export const cliOkResponse = z.object({ ok: z.literal(true) });

/**
 * The registry of every CLI contract schema, keyed by a stable name. cliJson
 * callers reference these directly; the A2 codegen step enumerates this map to
 * emit one Go type per entry. Keep the keys in sync with the Go struct names.
 */
export const cliContract = {
	RunnersResponse: cliRunnersResponse,
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
	WhoAmI: whoamiWire,
	OrgsResponse: cliOrgsResponse,
	MembersResponse: cliMembersResponse,
	TeamsResponse: cliTeamsResponse,
	ChannelsResponse: cliChannelsResponse,
	ChannelResponse: cliChannelResponse,
	AlertRulesResponse: cliAlertRulesResponse,
	AlertRuleResponse: cliAlertRuleResponse,
	ActivityResponse: cliActivityResponse,
	RolesResponse: cliRolesResponse,
	RoleResponse: cliRoleResponse,
	GrantsResponse: cliGrantsResponse,
	GrantResponse: cliGrantResponse,
	SsoProvidersResponse: cliSsoProvidersResponse,
	SsoProviderResponse: cliSsoProviderResponse,
	BillingResponse: cliBillingResponse,
	UsageResponse: cliUsageResponse,
	FleetPoolsResponse: cliFleetPoolsResponse,
	FleetPoolResponse: cliFleetPoolResponse,
	ProjectResponse: cliProjectResponse,
	EnvironmentsResponse: cliEnvironmentsResponse,
	EnvironmentResponse: cliEnvironmentResponse,
	ComponentsResponse: cliComponentsResponse,
	ComponentResponse: cliComponentResponse,
	ClassificationDimensionsResponse: cliClassificationDimensionsResponse,
	ClassificationAssignmentsResponse: cliClassificationAssignmentsResponse,
} as const;

export type CliContract = typeof cliContract;
