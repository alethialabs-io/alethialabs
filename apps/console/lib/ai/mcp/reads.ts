// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The declared READ tools (lib/ai/mcp/surface.ts), served under their contract names. Each one
// answers through the in-app tools its contract entry names in `replaces` (lib/ai/mcp/read-deps.ts
// runs them), so a connected agent and the in-app agent read through the same server actions, the
// same PDP verbs and the same secret-free trimming. What this module adds is the contract's shape:
// one tool per question, `kind` selecting the item, money as minor units with a currency, timestamps
// as ISO strings, and an unknown id as a refusal rather than an `{ error }` result.
//
// The two reads with no in-app counterpart are the design (with its revision) and the plan's
// counts, digest and cost change; read-deps.ts reads those directly.

import "server-only";
import type { InferToolOutput } from "ai";
import { z } from "zod";
import type { catalogTools } from "@/lib/ai/tools/compose";
import type { docsTools } from "@/lib/ai/tools/docs";
import type { readTools } from "@/lib/ai/tools/read";
import type { scannerTools } from "@/lib/ai/tools/scanner";
import { type HandledTool, McpToolRefusal, served } from "./served";
import { EXTERNAL_TOOLS, type ExternalToolName } from "./surface";

type ReadToolSet = ReturnType<typeof readTools>;
type CatalogToolSet = ReturnType<typeof catalogTools>;
type DocsToolSet = ReturnType<typeof docsTools>;
type ScannerToolSet = ReturnType<typeof scannerTools>;

/** The result of in-app read tool `N`. */
type ReadOut<N extends keyof ReadToolSet> = InferToolOutput<ReadToolSet[N]>;

/** The money shape every declared tool answers amounts in. */
interface Money {
	amount_minor: number;
	currency: string;
}

/** What `get_plan_result` adds to the in-app plan result. */
export interface PlanFacts {
	adds: number | null;
	changes: number | null;
	destroys: number | null;
	plan_sha256: string | null;
	monthly_cost_delta: Money | null;
}

/** One job, as `list_resources` lists it. */
interface JobSummary {
	id: string;
	type: string;
	status: string;
	project: string | null;
	project_id: string | null;
	environment_id: string | null;
	provider: string | null;
	created_at: string | null;
	completed_at: string | null;
}

/** Everything the reads reach outside themselves: the in-app tools and three direct reads. */
export interface ReadDeps {
	listProjects(): Promise<ReadOut<"list_projects">>;
	listJobs(): Promise<JobSummary[]>;
	listRunners(): Promise<ReadOut<"list_runners">>;
	listClusters(): Promise<ReadOut<"list_clusters">>;
	listConnectors(): Promise<ReadOut<"list_connectors">>;
	listCloudIdentities(): Promise<ReadOut<"list_cloud_identities">>;
	getProject(projectId: string): Promise<ReadOut<"get_project">>;
	getJob(jobId: string): Promise<ReadOut<"get_job">>;
	getDrift(projectId: string, environmentId: string | undefined): Promise<ReadOut<"get_drift_posture">>;
	getCloudInventory(cloudIdentityId: string): Promise<ReadOut<"get_cached_resources">>;
	getScan(jobId: string): Promise<InferToolOutput<ScannerToolSet["get_scan_result"]>>;
	/** The design of one environment (the project's own when `environmentId` is undefined). */
	readDesign(projectId: string, environmentId: string | undefined): Promise<unknown>;
	/** The project's design revision: the id of its latest design-write audit row, or 0. */
	designRevision(projectId: string): Promise<number>;
	getPlanResult(jobId: string): Promise<ReadOut<"get_plan_result">>;
	planFacts(jobId: string): Promise<PlanFacts>;
	listServices(): Promise<InferToolOutput<CatalogToolSet["list_services"]>>;
	/** The chosen cloud's valid values; refuses a cloud this deployment does not offer. */
	listServiceOptions(provider: string): Promise<unknown>;
	cidrForHosts(input: { hosts: number; base?: string; cloud?: string }): Promise<
		InferToolOutput<CatalogToolSet["cidr_for_hosts"]>
	>;
	compareProviders(scanJobId: string): Promise<InferToolOutput<ScannerToolSet["compare_providers"]>>;
	orgUsage(): Promise<ReadOut<"get_org_usage">>;
	aiUsage(): Promise<ReadOut<"get_ai_usage">>;
	billingSummary(): Promise<ReadOut<"get_billing_summary">>;
	searchDocs(input: { query: string; topK?: number }): Promise<InferToolOutput<DocsToolSet["search_docs"]>>;
}

/** The declared reads this module serves. */
export const READ_TOOL_NAMES = [
	"list_resources",
	"get_resource",
	"get_plan_result",
	"catalog",
	"cidr_for_hosts",
	"compare_providers",
	"get_usage",
	"search_docs",
] as const satisfies readonly ExternalToolName[];

/** One of {@link READ_TOOL_NAMES}. */
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

/** How many items `list_resources` returns when the caller names no limit. */
const DEFAULT_LIST_LIMIT = 20;

/** A JSON object, the shape the contract declares for documents another module owns. */
const jsonObject = z.record(z.string(), z.json());

/** A JSON array. */
const jsonArray = z.array(z.json());

/**
 * `value` as plain JSON: serialised and parsed back, so dates become ISO strings and nothing that is
 * not data survives, then checked to be an object.
 */
export function toJsonObject(value: unknown): z.output<typeof jsonObject> {
	return jsonObject.parse(JSON.parse(JSON.stringify(value)));
}

/** `value` as a plain JSON array (see {@link toJsonObject}). */
function toJsonArray(value: unknown): z.output<typeof jsonArray> {
	return jsonArray.parse(JSON.parse(JSON.stringify(value ?? [])));
}

/** A timestamp as an ISO string, or null. */
export function isoOrNull(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return typeof value === "string" ? value : value.toISOString();
}

/** A US-dollar amount in major units as minor units. */
function usdMinor(major: number): Money {
	return { amount_minor: Math.round(major * 100), currency: "USD" };
}

/** The first `limit` of `items`, and whether there were more. */
function page<T>(items: T[], limit: number | undefined): { items: T[]; truncated: boolean } {
	const max = limit ?? DEFAULT_LIST_LIMIT;
	return { items: items.slice(0, max), truncated: items.length > max };
}

/** The refusal an id that does not resolve answers with. */
function notFound(what: string): McpToolRefusal {
	return new McpToolRefusal("not_found", `No ${what} with that id is visible to this connection.`);
}

/** The declared read handlers, over `deps`. */
export function createReadHandlers(deps: ReadDeps): Record<ReadToolName, HandledTool> {
	return {
		list_resources: served(EXTERNAL_TOOLS.list_resources, async ({ kind, filter }) => {
			const projectId = filter?.project_id;
			const limit = filter?.limit;
			switch (kind) {
				case "project": {
					const { projects } = await deps.listProjects();
					return { kind, ...page(projects.filter((p) => !projectId || p.id === projectId), limit) };
				}
				case "job": {
					const environmentId = filter?.environment_id;
					const jobs = (await deps.listJobs()).filter(
						(j) =>
							(!projectId || j.project_id === projectId) &&
							(!environmentId || j.environment_id === environmentId),
					);
					return {
						kind,
						...page(
							jobs.map(({ project_id: _projectId, ...job }) => job),
							limit,
						),
					};
				}
				case "runner": {
					const { runners } = await deps.listRunners();
					return { kind, ...page(runners, limit) };
				}
				case "cluster": {
					const { clusters } = await deps.listClusters();
					return { kind, ...page(clusters.filter((c) => !projectId || c.project_id === projectId), limit) };
				}
				case "connector": {
					const { connectors } = await deps.listConnectors();
					return { kind, ...page(connectors.map((c) => ({ ...c, token_health: c.token_health ?? null })), limit) };
				}
				case "cloud_identity": {
					const { identities } = await deps.listCloudIdentities();
					return {
						kind,
						...page(
							identities.map((i) => ({
								id: i.id,
								name: i.name,
								display_id: i.displayId ?? null,
								provider: i.provider,
							})),
							limit,
						),
					};
				}
			}
		}),

		get_resource: served(EXTERNAL_TOOLS.get_resource, async ({ kind, id, environment_id: environmentId }) => {
			switch (kind) {
				case "project": {
					const project = await deps.getProject(id);
					return { kind, resource: { ...project, components: toJsonObject(project.components) } };
				}
				case "design": {
					// The design read authorizes the caller first; the revision is read only after it.
					const design = await deps.readDesign(id, environmentId);
					const revision = await deps.designRevision(id);
					return {
						kind,
						resource: {
							project_id: id,
							environment_id: environmentId ?? null,
							revision,
							design: toJsonObject(design),
						},
					};
				}
				case "job": {
					const job = await deps.getJob(id);
					// The in-app read answers a missing job with `{ error }` alone; a found job has an id.
					if (job.id === undefined) throw notFound("job");
					return {
						kind,
						resource: {
							...job,
							created_at: isoOrNull(job.created_at),
							completed_at: isoOrNull(job.completed_at),
						},
					};
				}
				case "drift": {
					const drift = await deps.getDrift(id, environmentId);
					if (drift.status === "no_data") {
						return { kind, resource: { has_data: false, in_sync: null, drifted: [], scanned_at: null } };
					}
					return {
						kind,
						resource: {
							has_data: true,
							in_sync: drift.in_sync ?? null,
							drifted: toJsonArray(drift.drifted),
							scanned_at: isoOrNull(drift.scanned_at),
						},
					};
				}
				case "cloud_inventory": {
					const inventory = await deps.getCloudInventory(id);
					return { kind, resource: { cloud_identity_id: id, inventory: toJsonObject(inventory) } };
				}
				case "scan": {
					const scan = await deps.getScan(id);
					if (scan.status === "NOT_FOUND") throw notFound("scan");
					if (scan.status !== "ready") {
						return { kind, resource: { scan_status: scan.status.toLowerCase(), stack: null, proposed: null } };
					}
					return {
						kind,
						resource: {
							scan_status: scan.status,
							stack: toJsonObject(scan.stack),
							proposed: toJsonObject(scan.proposed),
						},
					};
				}
			}
		}),

		get_plan_result: served(EXTERNAL_TOOLS.get_plan_result, async ({ job_id: jobId }) => {
			// The in-app read authorizes the caller for the job; the facts are read only after it.
			const result = await deps.getPlanResult(jobId);
			const facts = await deps.planFacts(jobId);
			return {
				job_id: jobId,
				status: result.status,
				error: result.error,
				...facts,
				verify_verdict: result.verify_verdict,
				verify_result: result.verify_result ? toJsonObject(result.verify_result) : null,
				output_keys: result.output_keys,
			};
		}),

		catalog: served(EXTERNAL_TOOLS.catalog, async ({ provider }) => {
			const { services } = await deps.listServices();
			const options = provider === undefined ? null : toJsonObject(await deps.listServiceOptions(provider));
			return {
				services: services.map((s) => ({
					kind: s.kind,
					label: s.label,
					classification: s.classification,
					service_names: s.serviceNames,
					deployment: s.deployment,
					unsupported_on: s.unsupportedOn,
				})),
				options,
			};
		}),

		cidr_for_hosts: served(EXTERNAL_TOOLS.cidr_for_hosts, async ({ hosts, base, cloud }) => {
			const cidr = await deps.cidrForHosts({ hosts, base, cloud });
			return {
				cidr: cidr.cidr,
				prefix: cidr.prefix,
				total_addresses: cidr.totalAddresses,
				usable_hosts: cidr.usableHosts,
				cloud: cloud ?? null,
			};
		}),

		compare_providers: served(EXTERNAL_TOOLS.compare_providers, async ({ scan_job_id: scanJobId }) => {
			const compared = await deps.compareProviders(scanJobId);
			if (compared.costs === undefined) {
				throw new McpToolRefusal("scan_not_ready", "The scan has not finished. Call wait_for_job, then try again.");
			}
			return {
				costs: compared.costs.map((c) => ({
					provider: c.provider,
					region: c.region ?? null,
					monthly: usdMinor(c.monthly),
				})),
			};
		}),

		get_usage: served(EXTERNAL_TOOLS.get_usage, async ({ kind }) => {
			switch (kind) {
				case "runner_minutes": {
					const u = await deps.orgUsage();
					return {
						kind,
						usage: {
							plan: u.plan,
							used_minutes: u.used_minutes,
							included_minutes: u.included_minutes,
							overage_minutes: u.overage_minutes,
							overage_cost: usdMinor(u.overage_cost_usd),
							running_jobs: u.running_jobs,
							max_concurrent_jobs: u.max_concurrent_jobs,
							period_start: isoOrNull(u.period_start),
							period_end: isoOrNull(u.period_end),
						},
					};
				}
				case "ai": {
					const a = await deps.aiUsage();
					return {
						kind,
						usage: {
							...a,
							session_reset_at: isoOrNull(a.session_reset_at),
							weekly_reset_at: isoOrNull(a.weekly_reset_at),
						},
					};
				}
				case "billing": {
					const b = await deps.billingSummary();
					return {
						kind,
						usage: {
							hosted: b.hosted,
							has_org: b.has_org,
							plan: b.plan,
							status: b.status,
							state: b.state,
							seats: b.seats,
							member_count: b.member_count,
							unit_amount:
								b.unit_amount !== null && b.currency !== null
									? { amount_minor: b.unit_amount, currency: b.currency }
									: null,
							cancel_at_period_end: b.cancel_at_period_end,
							current_period_end: isoOrNull(b.current_period_end),
						},
					};
				}
			}
		}),

		search_docs: served(EXTERNAL_TOOLS.search_docs, async ({ query, top_k: topK }) => deps.searchDocs({ query, topK })),
	};
}
