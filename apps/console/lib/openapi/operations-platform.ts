// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { componentSchemaWire } from "@/lib/cli/project-components";
import {
	badRequest,
	envQuery,
	forbidden,
	notFound,
	type OpenApiOperation,
	type OperationResponse,
	ok,
	PROJECT_ID_DESCRIPTION,
	serverError,
	uncontracted,
} from "@/lib/openapi/operation-kit";
import {
	cliAddonCatalogResponse,
	cliAlertRuleResponse,
	cliAlertRulesResponse,
	cliChannelResponse,
	cliChannelsResponse,
	cliCloudIdentitiesResponse,
	cliCloudInventoryResponse,
	cliClusterDetailResponse,
	cliClustersPageResponse,
	cliFleetPoolResponse,
	cliFleetPoolsResponse,
	cliKubeconfigMintPollResponse,
	cliKubeconfigMintRequest,
	cliKubeconfigMintResponse,
	cliOkResponse,
	cliRepositoriesResponse,
	cliRunnerRegistrationResponse,
	cliRunnersResponse,
	deployRunnerWire,
	providerStatusWire,
} from "@/lib/validations/cli-contract";
import {
	createAlertBody,
	createChannelBody,
	registerRunnerBody,
	updateFleetBody,
} from "@/lib/validations/cli-request-bodies";

/**
 * The platform operations of the public OpenAPI document: configurations, clusters and kubeconfig
 * mints, the component and add-on catalogs, cloud accounts, Git repositories, runners and the
 * managed fleet, and alerting. Part of `OPERATIONS` (lib/openapi/operations.ts); read that file for
 * what an entry states and how the drift test holds it to the route.
 */

/** The 402 the alerting routes answer below the plan that includes alerts. */
const alertsPlanRequired: OperationResponse = { status: 402, description: "Alerts need a Pro plan or higher." };

/** The `[provider]` segment of the cloud-account routes. */
const PROVIDER = {
	provider:
		"The cloud, by catalog slug, for example `aws`, `gcp` or `azure`. An account on a cloud this deployment no longer offers can still be read, verified and disconnected, but a cloud it does not offer cannot be newly connected (400).",
};

/**
 * The body of the cloud-account writes that name only the identity: the field each reads, without
 * a validator of its own. A function, so each operation's request component is its own schema.
 */
function identityOnlyBody(): z.ZodType {
	return z.object({ identity_id: z.string().describe("The cloud identity, as `init` returned it.") });
}

/** The body of `POST /api/cli/providers/{provider}/connect`. */
const connectProviderBody = z.object({
	identity_id: z.string().describe("The cloud identity, as `init` returned it."),
	credentials: z
		.object({
			role_arn: z.string().optional().describe("aws, alibaba: the role to assume."),
			wif_config: z.unknown().optional().describe("gcp: the workload identity federation credential configuration, as an object or a JSON string."),
			tenant_id: z.string().optional().describe("azure."),
			client_id: z.string().optional().describe("azure."),
			subscription_id: z.string().optional().describe("azure."),
			api_token: z.string().optional().describe("hetzner, digitalocean, civo: the cloud's API token. Stored encrypted; never returned."),
			s3_access_key: z.string().optional().describe("hetzner, optional: an Object Storage key pair, needed only for buckets."),
			s3_secret_key: z.string().optional().describe("hetzner, optional: an Object Storage key pair, needed only for buckets."),
			self_managed: z.boolean().optional(),
		})
		.optional()
		.describe("What the cloud needs; which fields depends on the cloud. A missing required field is a 400 naming it."),
});

/** The body of `POST /api/cli/runners/deploy`. */
const deployRunnerBody = z.object({
	name: z.string().describe("The runner's name. Required."),
	cloud_identity_id: z.string().describe("The cloud account to deploy into, by id: an organization account, or one of the caller's own. Required."),
	region: z.string().describe("The region to deploy into. Required."),
	assigned_runner_id: z.string().optional().describe("The existing runner that executes the deploy job. Omitted: the scheduler picks one."),
});

/** The connection result the cloud-account writes answer with, outside the wire contract. */
const CONNECTION_RESULT =
	"`identity_id`, `verified`, `status`, `error` and `missing_permissions`. Not part of the checked wire contract.";

/** Every platform operation. */
export const PLATFORM_OPERATIONS: readonly OpenApiOperation[] = [
	// ── Configurations ────────────────────────────────────────────────────────────────────────────
	{
		method: "get",
		path: "/api/cli/configurations",
		operationId: "listConfigurations",
		tag: "Configurations",
		summary: "List projects as configuration summaries",
		description: "Only the projects the caller may view, newest first, each with its default environment's stage and status.",
		permission: { action: "view", resource: "project" },
		responses: [uncontracted("`{\"configurations\": [...]}`. Not part of the checked wire contract."), serverError],
	},
	{
		method: "get",
		path: "/api/cli/configurations/{name}",
		operationId: "getConfiguration",
		tag: "Configurations",
		summary: "Get a project's flat configuration",
		permission: { action: "view", resource: "project" },
		pathParameters: { name: "The project, by name." },
		query: [envQuery],
		responses: [uncontracted("The project's configuration, flattened. Not part of the checked wire contract."), badRequest, notFound],
	},
	{
		method: "get",
		path: "/api/cli/configurations/by-project-name/{project_name}",
		operationId: "getConfigurationByProjectName",
		tag: "Configurations",
		summary: "Get a project's flat configuration by project name",
		permission: { action: "view", resource: "project" },
		pathParameters: { project_name: "The project, by name." },
		query: [envQuery],
		responses: [uncontracted("The project's configuration, flattened. Not part of the checked wire contract."), notFound, serverError],
	},
	{
		method: "get",
		path: "/api/cli/configurations/by-project-name/{project_name}/export",
		operationId: "exportConfiguration",
		tag: "Configurations",
		summary: "Export a project's design",
		description: "The design document as the console form holds it, serialised by the server.",
		permission: { action: "view", resource: "project" },
		pathParameters: { project_name: PROJECT_ID_DESCRIPTION },
		query: [
			{ name: "format", description: "`json`, the only format. Default `json`; any other value is a 400.", schema: z.string() },
			envQuery,
		],
		responses: [
			uncontracted("`content` (the document as a string), `filename` and `format`. Not part of the checked wire contract."),
			badRequest,
			notFound,
			serverError,
		],
	},

	// ── Clusters ──────────────────────────────────────────────────────────────────────────────────
	{
		method: "get",
		path: "/api/cli/clusters",
		operationId: "listClusters",
		tag: "Clusters",
		summary: "List clusters",
		description: "The organization's project clusters the caller may view, newest first, cursor-paged, with each project's name, region and default environment.",
		permission: { action: "view", resource: "project" },
		query: [
			{
				name: "limit",
				description: "Page size, a positive integer; values above 200 are served as 200. When neither `limit` nor `cursor` is sent, the page is 200. `page.limit` echoes what was served.",
				schema: z.string().regex(/^\d+$/),
			},
			{
				name: "cursor",
				description: "The `page.next_cursor` of the previous page. Empty or omitted: the first page.",
				schema: z.string(),
			},
		],
		responses: [ok(cliClustersPageResponse, "One page of clusters."), badRequest, serverError],
	},
	{
		method: "get",
		path: "/api/cli/clusters/{id}",
		operationId: "getCluster",
		tag: "Clusters",
		summary: "Get a cluster",
		description: "The cluster with its GitOps posture (null when it could not be read) and how to get a kubeconfig for it.",
		permission: { action: "view", resource: "project" },
		pathParameters: { id: "The cluster id." },
		responses: [ok(cliClusterDetailResponse, "The cluster."), notFound, serverError],
	},
	{
		method: "post",
		path: "/api/cli/clusters/{id}/kubeconfig",
		operationId: "requestKubeconfig",
		tag: "Clusters",
		summary: "Request a short-lived kubeconfig",
		description:
			"Queues a kubeconfig mint, bound to the credential that asked: only that credential can collect it, by polling the mint. The body carries the client's public key only. The permission asked depends on `tier`; a service token may mint `readonly` only. Every answer is `Cache-Control: no-store`.",
		permission: {
			perField: {
				field: "tier",
				cases: {
					readonly: { action: "access_readonly", resource: "cluster" },
					admin: { action: "access_admin", resource: "cluster" },
				},
			},
		},
		pathParameters: { id: "The cluster id." },
		body: cliKubeconfigMintRequest,
		responses: [
			ok(cliKubeconfigMintResponse, "The queued mint. Poll it for the kubeconfig.", 202),
			badRequest,
			{ status: 402, description: "The organization's usage limit is reached." },
			{ status: 403, description: "A service token asked for an `admin` kubeconfig." },
			notFound,
			{ status: 409, description: "The cluster has not been provisioned." },
			{
				status: 422,
				description:
					"This cluster cannot mint one: its cloud does not support it, it needs `shape: \"static\"`, it is a shared (namespace or vcluster) placement, or its cloud identity is unavailable.",
			},
			{ status: 429, description: "Too many mint requests; `Retry-After` says when to try again." },
			serverError,
		],
	},
	{
		method: "get",
		path: "/api/cli/clusters/{id}/kubeconfig/{mintId}",
		operationId: "pollKubeconfig",
		tag: "Clusters",
		summary: "Poll a kubeconfig mint",
		description:
			"Answers the mint's state until the runner completes it. Only the credential that requested the mint can collect it. Polls are not written to the activity log; the request that started the mint was. Every answer is `Cache-Control: no-store`.",
		permission: { action: "access_readonly", resource: "cluster" },
		pathParameters: { id: "The cluster id.", mintId: "The mint id, as the request answered it." },
		responses: [ok(cliKubeconfigMintPollResponse, "The mint's state."), forbidden, notFound, serverError],
	},

	// ── Catalog ───────────────────────────────────────────────────────────────────────────────────
	{
		method: "get",
		path: "/api/cli/schema/components",
		operationId: "getComponentSchema",
		tag: "Catalog",
		summary: "Get the component-kind registry",
		description:
			"Which component kinds exist, which are singletons, and the JSON Schema of the fields each accepts. The same for every caller; answers carry an `ETag`.",
		permission: { action: "view", resource: "project" },
		headers: [{ name: "If-None-Match", description: "An `ETag` from an earlier answer. When it still matches, the answer is 304 with no body." }],
		responses: [
			ok(componentSchemaWire, "The registry."),
			{ status: 304, description: "Not modified: the `If-None-Match` tag is current.", empty: true },
			serverError,
		],
	},
	{
		method: "get",
		path: "/api/cli/schema/addons",
		operationId: "getAddonCatalog",
		tag: "Catalog",
		summary: "Get the add-on catalog",
		description: "Each add-on's id, default chart version, the names of its secret settings and its non-secret defaults, and the chart-version rule. No values of secret settings.",
		permission: { action: "view", resource: "project" },
		responses: [ok(cliAddonCatalogResponse, "The catalog."), serverError],
	},

	// ── Cloud accounts ────────────────────────────────────────────────────────────────────────────
	{
		method: "get",
		path: "/api/cli/cloud-identities",
		operationId: "listCloudIdentities",
		tag: "Cloud accounts",
		summary: "List cloud accounts",
		description: "The verified accounts the caller may use: the organization's shared ones and, for a signed-in person, their own. A service token sees the organization's only.",
		permission: { action: "view", resource: "cloud_identity" },
		responses: [ok(cliCloudIdentitiesResponse, "The cloud accounts."), serverError],
	},
	{
		method: "get",
		path: "/api/cli/cloud-identities/{id}/inventory",
		operationId: "getCloudInventory",
		tag: "Cloud accounts",
		summary: "Get what was discovered in a cloud account",
		description: "Its networks, subnets and regions.",
		permission: { action: "view", resource: "cloud_identity" },
		pathParameters: { id: "The cloud identity id." },
		responses: [ok(cliCloudInventoryResponse, "The discovered inventory."), notFound, serverError],
	},
	{
		method: "post",
		path: "/api/cli/providers/{provider}/init",
		operationId: "initCloudIdentity",
		tag: "Cloud accounts",
		summary: "Start connecting a cloud account",
		description: "Gets or creates the caller's pending identity for the cloud. On aws it also returns the `external_id` the role's trust policy must name.",
		permission: { action: "manage_identities", resource: "cloud_identity" },
		pathParameters: PROVIDER,
		responses: [
			uncontracted("`identity_id`, and `external_id` (null except on aws). Not part of the checked wire contract."),
			badRequest,
			serverError,
		],
	},
	{
		method: "post",
		path: "/api/cli/providers/{provider}/connect",
		operationId: "connectCloudIdentity",
		tag: "Cloud accounts",
		summary: "Connect a cloud account",
		description: "Saves what the cloud needs to be reached and queues a connection test.",
		permission: { action: "manage_identities", resource: "cloud_identity" },
		pathParameters: PROVIDER,
		body: connectProviderBody,
		bodyUnvalidated: true,
		responses: [uncontracted(CONNECTION_RESULT), badRequest],
	},
	{
		method: "get",
		path: "/api/cli/providers/{provider}/status",
		operationId: "getCloudConnectionStatus",
		tag: "Cloud accounts",
		summary: "Get a cloud connection's status",
		permission: { action: "view", resource: "cloud_identity" },
		pathParameters: PROVIDER,
		responses: [ok(providerStatusWire, "The verified connection status."), badRequest, serverError],
	},
	{
		method: "post",
		path: "/api/cli/providers/{provider}/verify",
		operationId: "verifyCloudIdentity",
		tag: "Cloud accounts",
		summary: "Re-verify a cloud account",
		description: "Checks again, server-side, that the account can be reached and can provision.",
		permission: { action: "manage_identities", resource: "cloud_identity" },
		pathParameters: PROVIDER,
		body: identityOnlyBody(),
		bodyUnvalidated: true,
		responses: [uncontracted(CONNECTION_RESULT), badRequest],
	},
	{
		method: "post",
		path: "/api/cli/providers/{provider}/disconnect",
		operationId: "disconnectCloudIdentity",
		tag: "Cloud accounts",
		summary: "Disconnect a cloud account",
		description: "Returns the identity to its pending state; the projects that used it are left without a cloud account.",
		permission: { action: "manage_identities", resource: "cloud_identity" },
		pathParameters: PROVIDER,
		body: identityOnlyBody(),
		bodyUnvalidated: true,
		responses: [uncontracted("The disconnect result. Not part of the checked wire contract."), badRequest],
	},

	// ── Repositories ──────────────────────────────────────────────────────────────────────────────
	...[
		{ slug: "github", name: "GitHub", id: "listGithubRepositories" },
		{ slug: "gitlab", name: "GitLab", id: "listGitlabRepositories" },
		{ slug: "bitbucket", name: "Bitbucket", id: "listBitbucketRepositories" },
	].map(
		(provider): OpenApiOperation => ({
			method: "get",
			path: `/api/cli/repositories/${provider.slug}`,
			operationId: provider.id,
			tag: "Repositories",
			summary: `List ${provider.name} repositories`,
			description:
				"Lists the repositories the provider token in `X-Provider-Token` can see, by asking the provider with it. The token is used for this request only. Needs a valid credential and asks no permission, because it reads nothing of the organization's. An error from the provider is answered with the provider's status.",
			permission: { credentialOnly: true },
			headers: [{ name: "X-Provider-Token", description: "The caller's own token for the Git provider.", required: true }],
			responses: [
				ok(cliRepositoriesResponse, "The repositories."),
				{ status: 400, description: "`X-Provider-Token` is missing." },
				serverError,
			],
		}),
	),

	// ── Runners ───────────────────────────────────────────────────────────────────────────────────
	{
		method: "get",
		path: "/api/cli/runners",
		operationId: "listRunners",
		tag: "Runners",
		summary: "List runners",
		description: "The organization's runners, and on a self-managed deployment the managed fleet's too.",
		permission: { action: "view", resource: "runner" },
		responses: [ok(cliRunnersResponse, "The runners."), serverError],
	},
	{
		method: "post",
		path: "/api/cli/runners/register",
		operationId: "registerRunner",
		tag: "Runners",
		summary: "Register a self-operated runner",
		description: "Nothing is provisioned: the caller runs the runner. The answer carries the runner's token, returned this once.",
		permission: { action: "create", resource: "runner" },
		body: registerRunnerBody,
		responses: [
			ok(cliRunnerRegistrationResponse, "The registered runner and its token.", 201),
			{ status: 400, description: "The body is invalid, or `cloud_identity_id` is not one of the organization's cloud accounts." },
			serverError,
		],
	},
	{
		method: "post",
		path: "/api/cli/runners/deploy",
		operationId: "deployRunner",
		tag: "Runners",
		summary: "Deploy a runner into a cloud account",
		description: "Creates the runner record and queues a DEPLOY_RUNNER job.",
		permission: { action: "deploy", resource: "runner" },
		body: deployRunnerBody,
		bodyUnvalidated: true,
		responses: [
			ok(deployRunnerWire, "The runner and its queued job.", 201),
			{ status: 400, description: "A required field is missing, `cloud_identity_id` is not a UUID, or the account's cloud cannot host a deployed runner." },
			{ status: 404, description: "The cloud account or `assigned_runner_id` was not found, or is not this caller's to use." },
			{ status: 409, description: "The instance has no public URL (`NEXT_PUBLIC_APP_URL`), so the runner would have no console to connect to. Nothing is written." },
			serverError,
		],
	},
	{
		method: "delete",
		path: "/api/cli/runners/{id}",
		operationId: "deleteRunner",
		tag: "Runners",
		summary: "Delete a runner record",
		description: "Deletes the record only; nothing in the cloud is torn down.",
		permission: { action: "destroy", resource: "runner" },
		pathParameters: { id: "The runner id." },
		responses: [
			uncontracted("`{\"success\": true}`. Not part of the checked wire contract."),
			{ status: 403, description: "The runner belongs to another organization." },
			notFound,
			serverError,
		],
	},
	{
		method: "get",
		path: "/api/cli/fleet",
		operationId: "listFleetPools",
		tag: "Runners",
		summary: "List the managed fleet's warm pools",
		description: "One pool per cloud. On the hosted service the list is empty.",
		permission: { action: "view", resource: "fleet" },
		responses: [ok(cliFleetPoolsResponse, "The warm pools."), serverError],
	},
	{
		method: "put",
		path: "/api/cli/fleet/{provider}",
		operationId: "upsertFleetPool",
		tag: "Runners",
		summary: "Create or update a warm pool",
		description: "Changes only the fields sent; a new pool takes defaults for the rest. A pinned `version` clears `channel`. Self-managed deployments only.",
		permission: { action: "edit", resource: "fleet" },
		pathParameters: { provider: "The cloud, by catalog slug." },
		body: updateFleetBody,
		responses: [
			ok(cliFleetPoolResponse, "The pool."),
			{ status: 400, description: "The cloud is unknown, or the body is invalid." },
			{ status: 403, description: "The managed fleet is not available on this deployment." },
			serverError,
		],
	},

	// ── Alerts ────────────────────────────────────────────────────────────────────────────────────
	{
		method: "get",
		path: "/api/cli/alerts",
		operationId: "listAlertRules",
		tag: "Alerts",
		summary: "List alert rules",
		permission: { action: "view_alerts", resource: "alert" },
		responses: [ok(cliAlertRulesResponse, "The organization's rules with their channel ids, newest first."), serverError],
	},
	{
		method: "post",
		path: "/api/cli/alerts",
		operationId: "createAlertRule",
		tag: "Alerts",
		summary: "Create an alert rule",
		description: "Binds event-key patterns to channels; every channel must be this organization's.",
		permission: { action: "manage_alerts", resource: "alert" },
		body: createAlertBody,
		responses: [ok(cliAlertRuleResponse, "The created rule.", 201), badRequest, alertsPlanRequired, serverError],
	},
	{
		method: "delete",
		path: "/api/cli/alerts/{id}",
		operationId: "deleteAlertRule",
		tag: "Alerts",
		summary: "Delete an alert rule",
		permission: { action: "manage_alerts", resource: "alert" },
		pathParameters: { id: "The alert rule id." },
		responses: [ok(cliOkResponse, "Deleted."), notFound, serverError],
	},
	{
		method: "get",
		path: "/api/cli/channels",
		operationId: "listChannels",
		tag: "Alerts",
		summary: "List notification channels",
		description: "Channel secrets are never returned.",
		permission: { action: "view_alerts", resource: "alert" },
		responses: [ok(cliChannelsResponse, "The organization's channels, newest first."), serverError],
	},
	{
		method: "post",
		path: "/api/cli/channels",
		operationId: "createChannel",
		tag: "Alerts",
		summary: "Create a notification channel",
		description: "The endpoint is verified first; a channel never exists unverified. An endpoint that cannot be reached is a 400.",
		permission: { action: "manage_alerts", resource: "alert" },
		body: createChannelBody,
		responses: [ok(cliChannelResponse, "The created channel.", 201), badRequest, alertsPlanRequired, serverError],
	},
	{
		method: "delete",
		path: "/api/cli/channels/{id}",
		operationId: "deleteChannel",
		tag: "Alerts",
		summary: "Delete a notification channel",
		description: "Its rule bindings go with it; past deliveries are kept.",
		permission: { action: "manage_alerts", resource: "alert" },
		pathParameters: { id: "The channel id." },
		responses: [ok(cliOkResponse, "Deleted."), notFound, serverError],
	},
	{
		method: "post",
		path: "/api/cli/channels/{id}/verify",
		operationId: "verifyChannel",
		tag: "Alerts",
		summary: "Send a test event through a channel",
		permission: { action: "manage_alerts", resource: "alert" },
		pathParameters: { id: "The channel id." },
		responses: [
			ok(cliChannelResponse, "The channel, verified."),
			{ status: 400, description: "The test event could not be delivered." },
			notFound,
			serverError,
		],
	},
];
