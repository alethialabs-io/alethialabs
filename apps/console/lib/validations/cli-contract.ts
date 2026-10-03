// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { pageInfoSchema } from "@/lib/cli/paging";
import {
	cloudIdentities,
	jobLogs,
	jobs,
	KUBECONFIG_MINT_PUBLIC_KEY_B64URL_LENGTH,
	KUBECONFIG_MINT_SEALED_MAX_LENGTH,
	KUBECONFIG_MINT_TTL_DEFAULT_SECONDS,
	KUBECONFIG_MINT_TTL_MAX_SECONDS,
	KUBECONFIG_MINT_TTL_MIN_SECONDS,
	kubeconfigMintRequests,
	runners,
	projectCluster,
	projects,
} from "@/lib/db/schema";
import {
	cloudProvider,
	kubeconfigMintShape,
	kubeconfigMintTier,
} from "@/lib/db/schema/enums";
import type { NodeSize } from "@/types/jsonb.types";

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

/** Compact ArgoCD / GitOps posture for a cluster's default environment, derived from the
 *  Deploy-tab read model (readGitopsDeployStatus). null when it can't be computed. */
export const clusterGitops = z.object({
	mode: z.enum(["gitops", "direct"]),
	apps_repo: z.string().nullable(),
	revision: z.string().nullable(),
	total: z.number().int(),
	synced: z.number().int(),
	healthy: z.number().int(),
	status_available: z.boolean(),
	last_deploy_failed: z.boolean(),
	failed_step: z.string().nullable(),
	failure_message: z.string().nullable(),
});

/** How to get a kubeconfig for the cluster (#5250, #5322). Built by lib/clusters/kubeconfig-access.ts:
 *  `command` (`alethia cluster kubeconfig <selector>`) to run, with `alternative` the cloud-CLI command
 *  where there is one; or `note` saying why there is no command; or all null while the cluster has no
 *  name yet. */
export const clusterKubeconfig = z.object({
	command: z.string().nullable(),
	alternative: z.string().nullable(),
	note: z.string().nullable(),
});

/** A single cluster + its GitOps posture + its kubeconfig command (GET /api/cli/clusters/:id). */
export const cliClusterDetailResponse = z.object({
	cluster: clusterWire,
	gitops: clusterGitops.nullable(),
	kubeconfig: clusterKubeconfig,
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
	// Internal W3C trace correlation — carried enqueue → claim → runner, not CLI-facing.
	traceparent: true,
	// Internal poison-job cap + progress heartbeat — scheduler/recovery bookkeeping, not CLI-facing.
	attempts: true,
	max_attempts: true,
	progress_at: true,
	// Internal config_snapshot authenticity HMAC — verified server-side at claim, never on the CLI wire.
	config_snapshot_sig: true,
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

/** A receipt-signing key as a verifier may see it (GET /api/cli/signing-keys) — PUBLIC material
 * only. `source` says who vouches for it: an `org` row from the retained key_id→public_key history,
 * or the `platform` key the runner signs with today. `provider`/`status`/`active` are absent on the
 * platform entry, which has no org row behind it. Hand-written: the shape is a projection of
 * `org_signing_key` that deliberately drops `key_ref` and `backend` (custody detail, not a
 * verifier's business) and never carries private material. */
export const signingKeyWire = z.object({
	key_id: z.string(),
	public_key: z.string(),
	algorithm: z.string(),
	source: z.enum(["org", "platform"]),
	provider: z.string().nullable(),
	status: z.string().nullable(),
	active: z.boolean(),
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
	/** The isolation rung: `dedicated` owns a Fabric (and therefore a cluster), `vcluster` and
	 *  `namespace` are placed onto one that already exists. This is the product's headline
	 *  distinction, so a list of environments that omits it cannot answer the question the list
	 *  is for — which of these cost a cluster, and which were free. */
	placement_mode: z.string(),
	/** ArgoCD destination namespace for a shared placement; null for `dedicated`. */
	namespace: z.string().nullable(),
	/** The Fabric this environment is placed on, BY NAME rather than id — the whole point is to
	 *  show at a glance that several environments share one, and a uuid does not read as shared. */
	fabric: z.string().nullable(),
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
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	release_notes: z.string(),
	released_at: iso,
	github_release_url: z.url().nullable(),
	min_supported_version: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
});

/** Trusted release-workflow payload accepted by POST /api/releases/cli. */
export const cliReleasePublishWire = z.object({
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	release_notes: z.string(),
	released_at: iso,
	github_release_url: z.url(),
	commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
	min_supported_version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
	is_breaking: z.boolean().optional(),
});

// --- Response envelopes (what the CLI actually decodes off the wire) ---

export const cliRunnersResponse = z.object({ runners: z.array(runnerWire) });

/** POST /api/cli/runners/register — the runner plus its bearer token, returned ONCE. Only the
 *  token's SHA-256 is stored, so this response is the only opportunity to capture it; the CLI says so
 *  where it prints it. */
export const cliRunnerRegistrationResponse = z.object({
	runner: runnerWire,
	runner_token: z.string().min(1),
});
/** POST /api/cli/projects/:id/design — what the apply DID, and on a dry run what it WOULD do. `mode`
 *  is an enum rather than two booleans so a caller cannot read a plan as an apply. */
export const cliDesignApplyResponse = z.object({
	ok: z.literal(true),
	mode: z.enum(["applied", "staged", "dry-run"]),
	changes: z.array(
		z.object({
			kind: z.string(),
			name: z.string().nullable(),
			action: z.string(),
		}),
	),
});
/**
 * GET /api/cli/clusters — the org's project clusters, cursor-paged (#3672).
 *
 * `page` is the shared vocabulary and there is nothing beside it: unlike `cliJobsPageResponse`,
 * this envelope carries no `total`/`limit`/`offset` twins, because this endpoint never had them.
 * It returned the whole collection, so there is no pre-cursor caller whose offset walk has to
 * keep working — and adding the twins to look like the jobs envelope would be inventing a second
 * mechanism to be consistent with a compatibility shim.
 *
 * The array key stays `clusters`, so a reader that only wants the rows is unchanged; what changed
 * is that the rows may now be one page of them. `packages/core/api/api.go`'s `GetClusters` walks
 * `page.next_cursor` to exhaustion through `AllPages` for exactly that reason.
 */
export const cliClustersPageResponse = z.object({
	clusters: z.array(clusterWire),
	page: pageInfoSchema,
});
export const cliCloudIdentitiesResponse = z.object({
	cloud_identities: z.array(cloudIdentityWire),
});
/**
 * GET /api/jobs.
 *
 * `page` is the cursor vocabulary and the one to read. `total`, `limit` and `offset` are the
 * pre-cursor wire, kept because the shipped CLI's interactive pager still walks this endpoint by
 * offset (`apps/cli/cmd/jobs_table.go:40`) and will until #3667 replaces it; they are ADDITIVE
 * here, not a second mechanism — `total` and `limit` are `page.total` and `page.limit`, emitted
 * once and echoed, so the two halves of the envelope cannot disagree.
 */
export const cliJobsPageResponse = z.object({
	jobs: z.array(jobListItemWire),
	total: z.number().int(),
	limit: z.number().int(),
	offset: z.number().int(),
	page: pageInfoSchema,
});
/**
 * One DESTROY job a cascade queued (#5249), in destroy order. Carried next to `job` — which is the
 * TARGET's job, so a pre-cascade client reading only `job` still waits on the right thing — and
 * present only when the destroy queued more than one job.
 */
export const cascadeJobWire = z.object({
	job_id: z.uuid(),
	environment_id: z.uuid(),
	name: z.string(),
});
export const cliJobResponse = z.object({
	job: jobWire,
	cascade_jobs: z.array(cascadeJobWire).optional(),
});
/**
 * The `page` object every cursor-paged list response carries. Registered here — rather than
 * only inside the envelopes that embed it — so the shape is fixture-locked against
 * `api.PageInfo` on its own, before any route converts. Defined in lib/cli/paging.ts; this is
 * the registration, not a second definition.
 */
export const cliPageInfo = pageInfoSchema;
/** GET /api/cli/signing-keys result — the trusted-key set `alethia verify receipt` binds a
 * receipt's key_id against. One flat list so a verifier does not have to know which custody
 * model produced a key in order to trust it. */
export const cliSigningKeysResponse = z.object({
	signing_keys: z.array(signingKeyWire),
});
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

/** A cloud-indifferent node size on the wire — the same `{ vcpu, memory_gb }` shape as
 * `project_cluster.node_size` ({@link NodeSize}), which the Go resolver maps to the nearest catalog
 * machine type at provision time. Typed against the interface so the two cannot drift apart.
 * The bounds are the canvas inspector's ("vCPU per node" 1–96, "Memory per node" 1–768 GB), so the
 * terminal accepts exactly what the canvas does; strict, because the object is stored verbatim in a
 * jsonb column and a stray key would ride along onto the snapshot. */
const nodeSizeWire: z.ZodType<NodeSize> = z
	.object({
		vcpu: z.number().min(1).max(96),
		memory_gb: z.number().min(1).max(768),
	})
	.strict();

/** The node shape POST /api/cli/projects may carry (#5266) — `alethia project create
 * --instance-type` / `--node-size`. Both optional; omitting both writes no cluster row and the
 * template default (which equals the catalog default) applies. Giving BOTH is refused by the route,
 * not here: the fixture sampled from this schema carries every field, and it must still parse. Go
 * mirror: `api.ProjectNodeShape`, strict-decoded from `create_project_node_shape.json`. */
export const cliProjectNodeShapeRequest = z.object({
	instance_type: z.string().min(1).max(64).optional(),
	node_size: nodeSizeWire.optional(),
});
/** GET /api/cli/projects/:id/environments result. */
export const cliEnvironmentsResponse = z.object({
	environments: z.array(environmentWire),
	page: pageInfoSchema,
});
/**
 * One environment in a destroy tree (GET /api/cli/projects/:id/destroy-tree, #5249). The tree is the
 * target plus every LIVE environment placed on the Fabric it owns, tenants first and the owner last —
 * the order a cascade destroys them in. `waiting_on` is non-empty only on the owner: the tenants its
 * DESTROY will not start before, by name and status, so a tenant whose destroy FAILED is visible
 * rather than the owner's job waiting silently.
 */
export const destroyTreeNodeWire = z.object({
	environment_id: z.uuid(),
	name: z.string(),
	placement_mode: z.string(),
	status: z.string(),
	owns_fabric: z.boolean(),
	waiting_on: z.array(z.object({ name: z.string(), status: z.string() })),
});
/** GET /api/cli/projects/:id/destroy-tree result. */
export const cliDestroyTreeResponse = z.object({
	tree: z.array(destroyTreeNodeWire),
});
/** POST /api/cli/projects/:id/environments result. */
export const cliEnvironmentResponse = z.object({ environment: environmentWire });
/** GET /api/cli/projects/:id/components result. */
export const cliComponentsResponse = z.object({
	components: z.array(componentWire),
	page: pageInfoSchema,
});
/** POST /api/cli/projects/:id/components/:kind result. */
export const cliComponentResponse = z.object({ component: componentWire });

/** A single drifted resource (mirrors DriftDetail). */
export const driftDetailWire = z.object({
	address: z.string(),
	type: z.string(),
	kind: z.string(),
});
/**
 * GET /api/cli/projects/:id/drift result. `evaluated` is false when no DETECT_DRIFT job has
 * run yet — an honest "not proven" rather than a misleading in-sync=true.
 */
export const cliDriftResponse = z.object({
	evaluated: z.boolean(),
	in_sync: z.boolean(),
	drifted: z.number().int(),
	scanned_at: isoNullable,
	environment: z.string().nullable(),
	details: z.array(driftDetailWire),
});

/** A priced resource line (mirrors CostResourceLine). */
export const costResourceWire = z.object({
	address: z.string(),
	resource_type: z.string(),
	monthly_cost: z.number(),
});
/**
 * GET /api/cli/projects/:id/cost result. `priced` is false when no plan has ever priced the
 * environment — an honest "we don't know yet" rather than a fabricated zero.
 */
export const cliCostResponse = z.object({
	priced: z.boolean(),
	total_monthly: z.number().nullable(),
	currency: z.string(),
	captured_at: isoNullable,
	plan_job_id: z.string().nullable(),
	environment: z.string().nullable(),
	resources: z.array(costResourceWire),
});

/** One environment's promotion protection rules (mirrors ProtectionSummary). */
export const protectionRuleWire = z.object({
	environment_id: z.string(),
	environment: z.string(),
	require_predecessor: z.boolean(),
	require_verify_pass: z.boolean(),
	require_approval: z.boolean(),
	min_count: z.number().int().nullable(),
	soak_minutes: z.number().int().nullable(),
	cost_delta_threshold: z.number().nullable(),
});
/** GET /api/cli/projects/:id/protection result. */
export const cliProtectionResponse = z.object({
	rules: z.array(protectionRuleWire),
});

/** One environment's latest cluster-alive probe state (mirrors ProbeState). */
export const probeStateWire = z.object({
	environment_id: z.string(),
	environment: z.string(),
	// null = never probed; true = reachable; false = unreachable.
	reachable: z.boolean().nullable(),
	message: z.string().nullable(),
	probed_at: isoNullable,
});
/** GET /api/cli/projects/:id/probes result — one page of the project's environments. */
export const cliProbesResponse = z.object({
	probes: z.array(probeStateWire),
	page: pageInfoSchema,
});

/** One installed catalog add-on in an environment. */
export const addonWire = z.object({
	addon_id: z.string(),
	enabled: z.boolean(),
	mode: z.string(),
	version: z.string().nullable(),
	namespace: z.string().nullable(),
	status: z.string(),
	health: z.string().nullable(),
	sync: z.string().nullable(),
	last_synced_at: isoNullable,
});
/** GET /api/cli/projects/:id/addons result (installed catalog add-ons for one environment). */
export const cliAddonsResponse = z.object({
	environment: z.string(),
	addons: z.array(addonWire),
	page: pageInfoSchema,
});

/** One attached BYO Helm chart in an environment (scan_report omitted — status only). */
export const byoChartWire = z.object({
	id: z.string(),
	repo_url: z.string(),
	chart_path: z.string(),
	ref: z.string(),
	namespace: z.string(),
	status: z.string(),
	health: z.string().nullable(),
	sync: z.string().nullable(),
	scan_status: z.string(),
	scanned_at: isoNullable,
});
/** POST .../byo-charts — the attached chart's resolved (slugified) id, so a caller can address it
 *  afterwards without guessing how the server normalised what they sent. */
export const cliByoChartAttachResponse = z.object({
	ok: z.literal(true),
	id: z.string(),
});

/** POST .../byo-iac/scan and .../byo-charts/scan — the queued scan job, so a caller can follow it
 *  with `alethia jobs logs -f`. */
export const cliByoScanResponse = z.object({
	ok: z.literal(true),
	job_id: z.string(),
});

/** GET /api/cli/projects/:id/byo-charts result. */
export const cliByoChartsResponse = z.object({
	environment: z.string(),
	charts: z.array(byoChartWire),
	page: pageInfoSchema,
});

/** The BYO-IaC source attached to an environment (scan_report omitted — status only). */
export const iacSourceWire = z.object({
	id: z.string(),
	environment: z.string(),
	name: z.string(),
	repo_url: z.string(),
	ref: z.string().nullable(),
	path: z.string(),
	commit_sha: z.string().nullable(),
	deployed_commit_sha: z.string().nullable(),
	enabled: z.boolean(),
	scan_status: z.string(),
	scanned_at: isoNullable,
	status: z.string(),
	status_message: z.string().nullable(),
});
/** GET /api/cli/projects/:id/byo-iac result. `source` is null when no IaC source is attached. */
export const cliIacSourceResponse = z.object({
	source: iacSourceWire.nullable(),
});

/** One environment promotion (source → target), as listed. */
export const promotionWire = z.object({
	id: z.string(),
	source: z.string(),
	target: z.string(),
	status: z.string(),
	error_message: z.string().nullable(),
	created_at: iso,
	completed_at: isoNullable,
});
/** GET /api/cli/projects/:id/promotions result. */
export const cliPromotionsResponse = z.object({
	promotions: z.array(promotionWire),
	page: pageInfoSchema,
});

/** One approval slot on a promotion. */
export const promotionApprovalWire = z.object({
	id: z.string(),
	status: z.string(),
	name: z.string().nullable(),
	required_role: z.string().nullable(),
	comment: z.string().nullable(),
	decided_at: isoNullable,
});
/**
 * GET /api/cli/projects/:id/promotions/:pid result — a promotion with its approval slots. The
 * per-gate evaluation detail and the full config diff stay console-only; the CLI shows status,
 * the approval tally, and the approval slots.
 */
export const cliPromotionResponse = z.object({
	promotion: z.object({
		id: z.string(),
		source: z.string(),
		target: z.string(),
		status: z.string(),
		initiator: z.string().nullable(),
		error_message: z.string().nullable(),
		approved: z.number().int(),
		required: z.number().int(),
		approvals: z.array(promotionApprovalWire),
		created_at: iso,
		completed_at: isoNullable,
	}),
});

/** One staged (pending) change on an environment's canvas. */
export const stagedChangeWire = z.object({
	component_type: z.string(),
	op: z.string(),
	component_id: z.string().nullable(),
	created_at: iso,
});
/** GET /api/cli/projects/:id/staged result. */
export const cliStagedChangesResponse = z.object({
	environment: z.string(),
	changes: z.array(stagedChangeWire),
	page: pageInfoSchema,
});

/** One discovered network in a cloud identity's inventory. */
export const cloudNetworkWire = z.object({
	native_id: z.string(),
	name: z.string().nullable(),
	region: z.string().nullable(),
	provider: z.string(),
	cidr_block: z.string().nullable(),
	is_default: z.boolean(),
});
/** One discovered subnet in a cloud identity's inventory. */
export const cloudSubnetWire = z.object({
	native_id: z.string(),
	name: z.string().nullable(),
	region: z.string().nullable(),
	availability_zone: z.string().nullable(),
	cidr_block: z.string().nullable(),
	is_public: z.boolean(),
});
/** GET /api/cli/cloud-identities/:id/inventory result (discovered networking + regions). */
export const cliCloudInventoryResponse = z.object({
	networks: z.array(cloudNetworkWire),
	subnets: z.array(cloudSubnetWire),
	regions: z.array(z.string()),
});

/** GET /api/cli/org-settings result. null when the caller is in community (personal) mode. */
export const cliOrgSettingsResponse = z.object({
	settings: z
		.object({
			name: z.string(),
			slug: z.string(),
			description: z.string(),
			logo: z.string().nullable(),
			region: z.string(),
			default_env: z.string(),
			terraform_version: z.string(),
		})
		.nullable(),
});

/** One agent identity (a machine/agent persona), as read by the CLI. */
export const agentWire = z.object({
	id: z.string(),
	persona: z.string(),
	mission: z.string(),
	tool_scope: z.array(z.string()),
	memory_namespace: z.string(),
	project_id: z.string().nullable(),
	version: z.number().int(),
	created_at: iso,
	updated_at: iso,
});
/** GET /api/cli/agents result. */
export const cliAgentsResponse = z.object({ agents: z.array(agentWire) });
/** GET /api/cli/agents/:id result. */
export const cliAgentResponse = z.object({ agent: agentWire });

/** DELETE member/team/channel/alert/role/grant result. */
export const cliOkResponse = z.object({ ok: z.literal(true) });

// --- Short-lived kubeconfig mint (#5250 decisions 1–8; seams #5280) ---
//
// The channel, end to end:
//
//   1. client → POST /api/cli/clusters/:id/kubeconfig            body cliKubeconfigMintRequest
//      (the CLI, or the console via WebCrypto, generated an ephemeral X25519 keypair and sends ONLY
//      the public key)                                           → 202 cliKubeconfigMintResponse
//   2. runner → GET  /api/jobs/:id/kubeconfig-mint               → runnerKubeconfigMintSpec
//   3. runner mints in-network, HPKE-seals the kubeconfigMintCredential JSON to the client key with
//      the AAD bound to (mint id, cluster id) — packages/core/kubeaccess/seal.go
//   4. runner → POST /api/jobs/:id/kubeconfig-mint               body runnerKubeconfigMintResult
//                                                                → cliOkResponse
//   5. client → GET  /api/cli/clusters/:id/kubeconfig/:mintId    → cliKubeconfigMintPollResponse
//      (`ready` is served ONCE: the row is deleted on that read), then opens `sealed` locally.
//
// The console holds ciphertext only (kubeconfig_mint_requests.sealed_result) and can open nothing.
// kubeconfigMintCredential is the PLAINTEXT inside the seal: it is part of this contract because the
// CLI and the browser decode it and the runner encodes it, but it never crosses the console in the
// clear and no console route may ever return or accept it.

/** A 32-byte X25519 public key, base64url without padding (43 chars). Public material. */
export const kubeconfigMintPublicKey = z
	.string()
	.length(KUBECONFIG_MINT_PUBLIC_KEY_B64URL_LENGTH)
	.regex(/^[A-Za-z0-9_-]+$/, "must be unpadded base64url");

/** Smallest possible sealed blob: 32-byte `enc` + 16-byte GCM tag + 1 byte, base64url (66 chars). */
const KUBECONFIG_MINT_SEALED_MIN_LENGTH = 66;

/** HPKE `enc || ciphertext`, base64url without padding. Ciphertext only — never a credential. */
export const kubeconfigMintSealed = z
	.string()
	.min(KUBECONFIG_MINT_SEALED_MIN_LENGTH)
	.max(KUBECONFIG_MINT_SEALED_MAX_LENGTH)
	.regex(/^[A-Za-z0-9_-]+$/, "must be unpadded base64url");

/** Non-secret failure reason the runner reports (and the poll returns). Bounded so a runner cannot
 *  park an arbitrary blob — e.g. a credential in an error string — in the row. */
export const kubeconfigMintFailureReason = z.string().min(1).max(500);

const mintTier = z.enum(kubeconfigMintTier.enumValues);
const mintShape = z.enum(kubeconfigMintShape.enumValues);
const mintTtl = z
	.number()
	.int()
	.min(KUBECONFIG_MINT_TTL_MIN_SECONDS)
	.max(KUBECONFIG_MINT_TTL_MAX_SECONDS);

/** POST /api/cli/clusters/:id/kubeconfig — the mint request body. `tier` defaults to read-only and
 *  `ttl_seconds` to 1h (max 8h); `shape` is the client's explicit choice — the route refuses `exec`
 *  where the cloud can only mint a static certificate (Hetzner, Alibaba; decision 4). Strict: an
 *  unknown key (say, a `server` or a `cluster_name`) is refused — the cluster's identity comes from
 *  the row and the cloud, never from the request (mint-bind, #5250 §2). */
export const cliKubeconfigMintRequest = z
	.object({
		tier: mintTier.default("readonly"),
		ttl_seconds: mintTtl.default(KUBECONFIG_MINT_TTL_DEFAULT_SECONDS),
		shape: mintShape,
		client_public_key: kubeconfigMintPublicKey,
	})
	.strict();

/** The queued mint as the request route returns it. `expires_at` ends the POLL window, not the
 *  credential (that is `ttl_seconds`, counted by the cloud from the moment the runner mints). */
export const kubeconfigMintWire = z.object({
	id: z.uuid(),
	cluster_id: z.uuid(),
	job_id: z.uuid(),
	tier: mintTier,
	shape: mintShape,
	ttl_seconds: mintTtl,
	status: z.literal("pending"),
	expires_at: iso,
});

/** POST /api/cli/clusters/:id/kubeconfig result (202). */
export const cliKubeconfigMintResponse = z.object({ mint: kubeconfigMintWire });

/** GET /api/cli/clusters/:id/kubeconfig/:mintId — one poll. `private_endpoint` is null until the
 *  runner has reported it, and true means reaching the API needs network access (VPN/bastion) the
 *  laptop may not have (decision 6). A `ready` answer is served once; the next poll is a 404. */
export const cliKubeconfigMintPollResponse = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("pending"),
		private_endpoint: z.boolean().nullable(),
		expires_at: iso,
	}),
	z.object({
		status: z.literal("ready"),
		private_endpoint: z.boolean(),
		sealed: kubeconfigMintSealed,
	}),
	z.object({
		status: z.literal("failed"),
		private_endpoint: z.boolean().nullable(),
		reason: kubeconfigMintFailureReason,
	}),
	z.object({
		status: z.literal("expired"),
		private_endpoint: z.boolean().nullable(),
	}),
]);

/** GET /api/jobs/:id/kubeconfig-mint (runner-authenticated) — what the MINT_KUBECONFIG job must
 *  mint and whom to seal it to. Served only to the runner that owns the executing job. Holds no
 *  secret: the client key is public, and the runner resolves the cluster's endpoint and identity
 *  itself (mint-bind). */
export const runnerKubeconfigMintSpec = z.object({
	mint_id: z.uuid(),
	cluster_id: z.uuid(),
	tier: mintTier,
	shape: mintShape,
	ttl_seconds: mintTtl,
	client_public_key: kubeconfigMintPublicKey,
});

/** POST /api/jobs/:id/kubeconfig-mint (runner-authenticated) — the ONE-SHOT result channel. This
 *  is the only path a mint result takes: never execution_metadata, job_logs or the job status post
 *  (#5250 decision 3). A `ready` post carries ciphertext only. Strict, so a plaintext field cannot
 *  ride along unnoticed. */
export const runnerKubeconfigMintResult = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ready"),
			mint_id: z.uuid(),
			sealed: kubeconfigMintSealed,
			private_endpoint: z.boolean(),
		})
		.strict(),
	z
		.object({
			status: z.literal("failed"),
			mint_id: z.uuid(),
			reason: kubeconfigMintFailureReason,
			private_endpoint: z.boolean().nullable(),
		})
		.strict(),
]);

/**
 * The PLAINTEXT inside `sealed` — what the runner seals and the client opens. NEVER a console wire
 * shape: no route may accept or return it. `exec` carries what an ExecCredential and the kubeconfig's
 * cluster stanza need (`alethia cluster token` caches it until `expires_at`); `static` carries a
 * complete kubeconfig with the credential embedded. `certificate_authority_data` is the standard
 * base64 the kubeconfig field takes.
 */
export const kubeconfigMintCredential = z.discriminatedUnion("shape", [
	z
		.object({
			shape: z.literal("exec"),
			tier: mintTier,
			server: z.url(),
			certificate_authority_data: z.base64(),
			token: z.string().min(1),
			expires_at: iso,
		})
		.strict(),
	z
		.object({
			shape: z.literal("static"),
			tier: mintTier,
			kubeconfig: z.string().min(1),
			expires_at: iso,
		})
		.strict(),
]);

/**
 * The kubeconfig_mint_requests insert, derived from the table (drizzle-zod) with the column refined
 * to the channel's own validators. The request route builds the row from a parsed
 * cliKubeconfigMintRequest plus the resolved cluster and actor; `sealed_result`, `failure_reason`,
 * `status` and `private_endpoint` are the runner's to write and are omitted here.
 */
export const kubeconfigMintRequestInsert = createInsertSchema(kubeconfigMintRequests, {
	client_public_key: kubeconfigMintPublicKey,
	ttl_seconds: mintTtl,
}).omit({
	id: true,
	sealed_result: true,
	failure_reason: true,
	status: true,
	private_endpoint: true,
	created_at: true,
});

export type CliKubeconfigMintRequest = z.infer<typeof cliKubeconfigMintRequest>;
export type CliKubeconfigMintPollResponse = z.infer<typeof cliKubeconfigMintPollResponse>;
export type RunnerKubeconfigMintSpec = z.infer<typeof runnerKubeconfigMintSpec>;
export type RunnerKubeconfigMintResult = z.infer<typeof runnerKubeconfigMintResult>;
export type KubeconfigMintCredential = z.infer<typeof kubeconfigMintCredential>;

/**
 * The registry of every CLI contract schema, keyed by a stable name. cliJson
 * callers reference these directly; the A2 codegen step enumerates this map to
 * emit one Go type per entry. Keep the keys in sync with the Go struct names.
 */
export const cliContract = {
	RunnersResponse: cliRunnersResponse,
	ByoChartAttachResponse: cliByoChartAttachResponse,
	ByoScanResponse: cliByoScanResponse,
	RunnerRegistrationResponse: cliRunnerRegistrationResponse,
	DesignApplyResponse: cliDesignApplyResponse,
	ClustersPageResponse: cliClustersPageResponse,
	ClusterDetailResponse: cliClusterDetailResponse,
	CloudIdentitiesResponse: cliCloudIdentitiesResponse,
	JobsPageResponse: cliJobsPageResponse,
	JobResponse: cliJobResponse,
	PageInfo: cliPageInfo,
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
	ProjectNodeShapeRequest: cliProjectNodeShapeRequest,
	EnvironmentsResponse: cliEnvironmentsResponse,
	EnvironmentResponse: cliEnvironmentResponse,
	DestroyTreeResponse: cliDestroyTreeResponse,
	ComponentsResponse: cliComponentsResponse,
	ComponentResponse: cliComponentResponse,
	DriftResponse: cliDriftResponse,
	CostResponse: cliCostResponse,
	ProtectionResponse: cliProtectionResponse,
	ProbesResponse: cliProbesResponse,
	AddonsResponse: cliAddonsResponse,
	ByoChartsResponse: cliByoChartsResponse,
	IacSourceResponse: cliIacSourceResponse,
	PromotionsResponse: cliPromotionsResponse,
	PromotionResponse: cliPromotionResponse,
	StagedChangesResponse: cliStagedChangesResponse,
	CloudInventoryResponse: cliCloudInventoryResponse,
	OrgSettingsResponse: cliOrgSettingsResponse,
	AgentsResponse: cliAgentsResponse,
	AgentResponse: cliAgentResponse,
	ClassificationDimensionsResponse: cliClassificationDimensionsResponse,
	ClassificationAssignmentsResponse: cliClassificationAssignmentsResponse,
	KubeconfigMintRequest: cliKubeconfigMintRequest,
	KubeconfigMintResponse: cliKubeconfigMintResponse,
	KubeconfigMintPollResponse: cliKubeconfigMintPollResponse,
	RunnerKubeconfigMintSpec: runnerKubeconfigMintSpec,
	RunnerKubeconfigMintResult: runnerKubeconfigMintResult,
	KubeconfigMintCredential: kubeconfigMintCredential,
} as const;

export type CliContract = typeof cliContract;
