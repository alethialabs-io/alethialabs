// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The declared reads (lib/ai/mcp/reads.ts) over stood-in dependencies. What is asserted is what the
// reads add on top of the in-app tools they answer through: one tool per question selected by
// `kind`, the contract's shapes (each result passes the tool's own output schema, or `call` throws),
// money as minor units with a currency, timestamps as ISO strings, the list filters and limit, and
// an unknown id as a refusal rather than an `{ error }` result.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createReadHandlers, isoOrNull, type ReadDeps, toJsonObject } from "@/lib/ai/mcp/reads";
import type { HandlerContext } from "@/lib/ai/mcp/served";

const CTX: HandlerContext = {
	actor: { userId: "user-1", orgId: "org-1", credential: "agent_oauth", credentialRef: "client-1" },
	appOrigin: "https://console.example",
};

/**
 * Dependencies that fail loudly unless a test stands one in. A stand-in returns only the fields the
 * read uses, so the result is typed loosely; the read's own output schema still checks every answer.
 */
function deps(over: Partial<Record<keyof ReadDeps, unknown>> = {}): ReadDeps {
	const unexpected = (name: string) =>
		vi.fn(async () => {
			throw new Error(`unexpected call: ${name}`);
		});
	return {
		listProjects: unexpected("listProjects"),
		listJobs: unexpected("listJobs"),
		listRunners: unexpected("listRunners"),
		listClusters: unexpected("listClusters"),
		listConnectors: unexpected("listConnectors"),
		listCloudIdentities: unexpected("listCloudIdentities"),
		getProject: unexpected("getProject"),
		getJob: unexpected("getJob"),
		getDrift: unexpected("getDrift"),
		getCloudInventory: unexpected("getCloudInventory"),
		getScan: unexpected("getScan"),
		readDesign: unexpected("readDesign"),
		designRevision: unexpected("designRevision"),
		getPlanResult: unexpected("getPlanResult"),
		planFacts: unexpected("planFacts"),
		listServices: unexpected("listServices"),
		listServiceOptions: unexpected("listServiceOptions"),
		cidrForHosts: unexpected("cidrForHosts"),
		compareProviders: unexpected("compareProviders"),
		orgUsage: unexpected("orgUsage"),
		aiUsage: unexpected("aiUsage"),
		billingSummary: unexpected("billingSummary"),
		searchDocs: unexpected("searchDocs"),
		...over,
	} as never;
}

/** Calls read `name` over `d` with `input`. */
function call(d: ReadDeps, name: keyof ReturnType<typeof createReadHandlers>, input: unknown) {
	return createReadHandlers(d)[name].call(input, CTX);
}

const PROJECT = {
	id: "p1",
	name: "api",
	slug: "api",
	status: "ACTIVE",
	provider: "aws",
	region: "eu-west-1",
	environment: "production",
};

describe("list_resources", () => {
	it("lists projects, narrowed to one project and cut at the limit", async () => {
		const listProjects = vi.fn(async () => ({ projects: [PROJECT, { ...PROJECT, id: "p2", name: "web" }] }));
		expect(await call(deps({ listProjects }), "list_resources", { kind: "project" })).toEqual({
			kind: "project",
			items: [PROJECT, { ...PROJECT, id: "p2", name: "web" }],
			truncated: false,
		});
		expect(await call(deps({ listProjects }), "list_resources", { kind: "project", filter: { project_id: "p2" } })).toMatchObject({
			items: [{ id: "p2" }],
		});
		expect(await call(deps({ listProjects }), "list_resources", { kind: "project", filter: { limit: 1 } })).toMatchObject({
			items: [{ id: "p1" }],
			truncated: true,
		});
	});

	it("lists jobs by project and environment, without the project id the contract does not carry", async () => {
		const job = {
			id: "j1",
			type: "PLAN",
			status: "SUCCESS",
			project: "api",
			project_id: "p1",
			environment_id: "e1",
			provider: "aws",
			created_at: "2026-11-24T10:00:00.000Z",
			completed_at: null,
		};
		const listJobs = vi.fn(async () => [job, { ...job, id: "j2", project_id: "p2" }, { ...job, id: "j3", environment_id: "e2" }]);
		const result = await call(deps({ listJobs }), "list_resources", {
			kind: "job",
			filter: { project_id: "p1", environment_id: "e1" },
		});
		const { project_id: _dropped, ...item } = job;
		expect(result).toEqual({ kind: "job", items: [item], truncated: false });
		expect((await call(deps({ listJobs }), "list_resources", { kind: "job" })).items).toHaveLength(3);
	});

	it("lists runners, clusters by project, connectors and cloud identities in the contract's names", async () => {
		const runner = { id: "r1", name: "r", operator: "managed" as const, status: null, version: null, online: false };
		const cluster = {
			id: "c1",
			project_id: "p1",
			name: "api",
			region: null,
			environment: null,
			status: "ACTIVE",
			provider: null,
			cluster: null,
			databases: [],
			caches: [],
			dns: null,
		};
		const d = deps({
			listRunners: vi.fn(async () => ({ runners: [runner] })),
			listClusters: vi.fn(async () => ({ clusters: [cluster, { ...cluster, id: "c2", project_id: "p2" }] })),
			listConnectors: vi.fn(async () => ({
				connectors: [
					{ slug: "github", name: "GitHub", category: "git" as const, status: "active" as const, connected: true, token_health: undefined },
				],
			})),
			listCloudIdentities: vi.fn(async () => ({
				identities: [{ id: "ci1", name: "prod", displayId: "1234", provider: "aws" }],
			})),
		});
		expect((await call(d, "list_resources", { kind: "runner" })).items).toEqual([runner]);
		expect((await call(d, "list_resources", { kind: "cluster", filter: { project_id: "p1" } })).items).toEqual([cluster]);
		expect((await call(d, "list_resources", { kind: "cluster" })).items).toHaveLength(2);
		expect((await call(d, "list_resources", { kind: "connector" })).items).toEqual([
			{ slug: "github", name: "GitHub", category: "git", status: "active", connected: true, token_health: null },
		]);
		expect((await call(d, "list_resources", { kind: "cloud_identity" })).items).toEqual([
			{ id: "ci1", name: "prod", display_id: "1234", provider: "aws" },
		]);
	});

	it("answers a missing display id as null", async () => {
		const d = deps({
			listCloudIdentities: vi.fn(async () => ({ identities: [{ id: "ci1", name: "prod", displayId: undefined, provider: "gcp" }] })),
		});
		expect((await call(d, "list_resources", { kind: "cloud_identity" })).items).toEqual([
			{ id: "ci1", name: "prod", display_id: null, provider: "gcp" },
		]);
	});
});

describe("get_resource", () => {
	it("reads a project with its components as plain JSON", async () => {
		const getProject = vi.fn(async () => ({
			id: "p1",
			name: "api",
			status: "ACTIVE",
			region: "eu-west-1",
			provider: "aws",
			environment: "production",
			components: { cluster: null, network: null, dns_enabled: false, databases: [], caches: [], queues: [], topics: [], nosql: [], secrets: [] },
		}));
		const result = await call(deps({ getProject }), "get_resource", { kind: "project", id: "p1" });
		expect(result).toMatchObject({ kind: "project", resource: { id: "p1", components: { dns_enabled: false } } });
		expect(getProject).toHaveBeenCalledWith("p1");
	});

	it("reads a design with its revision, the design first so the caller is authorized before the revision is read", async () => {
		const order: string[] = [];
		const d = deps({
			readDesign: vi.fn(async () => {
				order.push("design");
				return { project: { project_name: "api" } };
			}),
			designRevision: vi.fn(async () => {
				order.push("revision");
				return 42;
			}),
		});
		expect(await call(d, "get_resource", { kind: "design", id: "p1", environment_id: "e1" })).toEqual({
			kind: "design",
			resource: { project_id: "p1", environment_id: "e1", revision: 42, design: { project: { project_name: "api" } } },
		});
		expect(order).toEqual(["design", "revision"]);
		expect(await call(d, "get_resource", { kind: "design", id: "p1" })).toMatchObject({ resource: { environment_id: null } });
	});

	it("reads a job with ISO timestamps, and refuses one that is not found", async () => {
		const created = new Date("2026-11-24T10:00:00.000Z");
		const getJob = vi.fn(async (id: string) =>
			id === "j1"
				? { id: "j1", type: "PLAN", status: "SUCCESS", error: null, project_id: "p1", created_at: created, completed_at: null }
				: { error: "Job not found." },
		);
		expect(await call(deps({ getJob }), "get_resource", { kind: "job", id: "j1" })).toEqual({
			kind: "job",
			resource: {
				id: "j1",
				type: "PLAN",
				status: "SUCCESS",
				error: null,
				project_id: "p1",
				created_at: "2026-11-24T10:00:00.000Z",
				completed_at: null,
			},
		});
		await expect(call(deps({ getJob }), "get_resource", { kind: "job", id: "nope" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("reads drift, and says so when detection has not run", async () => {
		const getDrift = vi.fn(async (projectId: string) =>
			projectId === "p1"
				? { status: "ok", in_sync: false, drifted: [{ address: "aws_s3_bucket.a" }], details: [], scanned_at: new Date("2026-11-24T09:00:00.000Z") }
				: { status: "no_data", message: "No drift detection has run for this project yet." },
		);
		expect(await call(deps({ getDrift }), "get_resource", { kind: "drift", id: "p1", environment_id: "e1" })).toEqual({
			kind: "drift",
			resource: { has_data: true, in_sync: false, drifted: [{ address: "aws_s3_bucket.a" }], scanned_at: "2026-11-24T09:00:00.000Z" },
		});
		expect(getDrift).toHaveBeenCalledWith("p1", "e1");
		expect(await call(deps({ getDrift }), "get_resource", { kind: "drift", id: "p2" })).toEqual({
			kind: "drift",
			resource: { has_data: false, in_sync: null, drifted: [], scanned_at: null },
		});
	});

	it("answers an unknown sync state and no drifted list as null and empty", async () => {
		const getDrift = vi.fn(async () => ({ status: "ok", in_sync: undefined, drifted: undefined, details: [], scanned_at: null }));
		expect(await call(deps({ getDrift }), "get_resource", { kind: "drift", id: "p1" })).toEqual({
			kind: "drift",
			resource: { has_data: true, in_sync: null, drifted: [], scanned_at: null },
		});
	});

	it("reads a cloud inventory as a JSON object", async () => {
		const getCloudInventory = vi.fn(async () => ({ vpcs: [{ id: "vpc-1" }] }));
		expect(await call(deps({ getCloudInventory }), "get_resource", { kind: "cloud_inventory", id: "ci1" })).toEqual({
			kind: "cloud_inventory",
			resource: { cloud_identity_id: "ci1", inventory: { vpcs: [{ id: "vpc-1" }] } },
		});
	});

	it("reads a scan in each of its states", async () => {
		const getScan = vi.fn(async (jobId: string) => {
			if (jobId === "ready") return { status: "ready", stack: { runtime: "node" }, proposed: { provider: "aws" }, openInCanvasUrl: "/x" };
			if (jobId === "pending") return { status: "PENDING", jobStatus: "PROCESSING" };
			return { status: "NOT_FOUND" };
		});
		const d = deps({ getScan });
		expect(await call(d, "get_resource", { kind: "scan", id: "ready" })).toEqual({
			kind: "scan",
			resource: { scan_status: "ready", stack: { runtime: "node" }, proposed: { provider: "aws" } },
		});
		expect(await call(d, "get_resource", { kind: "scan", id: "pending" })).toEqual({
			kind: "scan",
			resource: { scan_status: "pending", stack: null, proposed: null },
		});
		await expect(call(d, "get_resource", { kind: "scan", id: "gone" })).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("get_plan_result", () => {
	it("joins the in-app plan result with the counts, digest and cost change, the result read first", async () => {
		const order: string[] = [];
		const d = deps({
			getPlanResult: vi.fn(async () => {
				order.push("result");
				return { status: "SUCCESS", error: null, output_keys: ["plan_result"], verify_verdict: "pass", verify_result: { verdict: "pass" } };
			}),
			planFacts: vi.fn(async () => {
				order.push("facts");
				return {
					adds: 3,
					changes: 1,
					destroys: 0,
					plan_sha256: "a".repeat(64),
					monthly_cost_delta: { amount_minor: 1250, currency: "USD" },
				};
			}),
		});
		expect(await call(d, "get_plan_result", { job_id: "plan-1" })).toEqual({
			job_id: "plan-1",
			status: "SUCCESS",
			error: null,
			adds: 3,
			changes: 1,
			destroys: 0,
			monthly_cost_delta: { amount_minor: 1250, currency: "USD" },
			verify_verdict: "pass",
			verify_result: { verdict: "pass" },
			plan_sha256: "a".repeat(64),
			output_keys: ["plan_result"],
		});
		expect(order).toEqual(["result", "facts"]);
	});

	it("answers a plan with no verify report as null", async () => {
		const d = deps({
			getPlanResult: vi.fn(async () => ({ status: "QUEUED", error: null, output_keys: [], verify_verdict: null, verify_result: null })),
			planFacts: vi.fn(async () => ({ adds: null, changes: null, destroys: null, plan_sha256: null, monthly_cost_delta: null })),
		});
		expect(await call(d, "get_plan_result", { job_id: "plan-1" })).toMatchObject({ verify_result: null, adds: null });
	});
});

describe("catalog", () => {
	const services = {
		services: [
			{
				kind: "database",
				label: "Database",
				classification: "data",
				serviceNames: { aws: "RDS" },
				deployment: { aws: "managed" },
				unsupportedOn: [],
			},
		],
	};

	it("lists every service, and a cloud's options only when one is named", async () => {
		const listServiceOptions = vi.fn(async () => ({ provider: "hetzner", regions: [{ code: "fsn1" }] }));
		const d = deps({ listServices: vi.fn(async () => services), listServiceOptions });
		expect(await call(d, "catalog", {})).toEqual({
			services: [
				{
					kind: "database",
					label: "Database",
					classification: "data",
					service_names: { aws: "RDS" },
					deployment: { aws: "managed" },
					unsupported_on: [],
				},
			],
			options: null,
		});
		expect(listServiceOptions).not.toHaveBeenCalled();
		expect(await call(d, "catalog", { provider: "hetzner" })).toMatchObject({ options: { provider: "hetzner" } });
		expect(listServiceOptions).toHaveBeenCalledWith("hetzner");
	});
});

describe("cidr_for_hosts", () => {
	it("sizes a network in the contract's names and echoes the cloud", async () => {
		const cidrForHosts = vi.fn(async () => ({ cidr: "10.0.0.0/22", prefix: 22, totalAddresses: 1024, usableHosts: 1022 }));
		expect(await call(deps({ cidrForHosts }), "cidr_for_hosts", { hosts: 600, cloud: "aws" })).toEqual({
			cidr: "10.0.0.0/22",
			prefix: 22,
			total_addresses: 1024,
			usable_hosts: 1022,
			cloud: "aws",
		});
		expect(cidrForHosts).toHaveBeenCalledWith({ hosts: 600, base: undefined, cloud: "aws" });
		expect(await call(deps({ cidrForHosts }), "cidr_for_hosts", { hosts: 10 })).toMatchObject({ cloud: null });
	});
});

describe("compare_providers", () => {
	it("answers each cloud's monthly cost in minor units", async () => {
		const compareProviders = vi.fn(async () => ({
			currency: "USD",
			costs: [
				{ provider: "hetzner", region: "fsn1", monthly: 41.5 },
				{ provider: "aws", region: undefined, monthly: 120 },
			],
		}));
		expect(await call(deps({ compareProviders }), "compare_providers", { scan_job_id: "scan-1" })).toEqual({
			costs: [
				{ provider: "hetzner", region: "fsn1", monthly: { amount_minor: 4150, currency: "USD" } },
				{ provider: "aws", region: null, monthly: { amount_minor: 12000, currency: "USD" } },
			],
		});
	});

	it("refuses a scan that has not finished", async () => {
		const compareProviders = vi.fn(async () => ({ error: "Scan not ready — analyze the repo first." }));
		await expect(call(deps({ compareProviders }), "compare_providers", { scan_job_id: "scan-1" })).rejects.toMatchObject({
			code: "scan_not_ready",
		});
	});
});

describe("get_usage", () => {
	it("answers runner minutes with the overage in minor units", async () => {
		const orgUsage = vi.fn(async () => ({
			plan: "team",
			used_minutes: 120.5,
			included_minutes: 1000,
			overage_minutes: 0,
			overage_cost_usd: 1.23,
			pct: 12,
			running_jobs: 1,
			max_concurrent_jobs: 4,
			period_start: new Date("2026-11-01T00:00:00.000Z"),
			period_end: "2026-12-01T00:00:00.000Z",
		}));
		expect(await call(deps({ orgUsage }), "get_usage", { kind: "runner_minutes" })).toEqual({
			kind: "runner_minutes",
			usage: {
				plan: "team",
				used_minutes: 120.5,
				included_minutes: 1000,
				overage_minutes: 0,
				overage_cost: { amount_minor: 123, currency: "USD" },
				running_jobs: 1,
				max_concurrent_jobs: 4,
				period_start: "2026-11-01T00:00:00.000Z",
				period_end: "2026-12-01T00:00:00.000Z",
			},
		});
	});

	it("answers AI usage with ISO reset times", async () => {
		const aiUsage = vi.fn(async () => ({
			enabled: true,
			tier: "pro",
			session_used: 1,
			session_budget: 10,
			session_reset_at: null,
			weekly_used: 2,
			weekly_budget: 50,
			weekly_reset_at: new Date("2026-11-30T00:00:00.000Z"),
			purchased_balance: null,
		}));
		expect(await call(deps({ aiUsage }), "get_usage", { kind: "ai" })).toMatchObject({
			kind: "ai",
			usage: { session_reset_at: null, weekly_reset_at: "2026-11-30T00:00:00.000Z" },
		});
	});

	it("answers billing with the seat price as money, or null without one", async () => {
		const summary = {
			hosted: true,
			has_org: true,
			plan: "team",
			status: "active",
			state: "active",
			seats: 5,
			member_count: 3,
			unit_amount: 1900,
			currency: "eur",
			unit_amount_usd: null,
			cancel_at_period_end: false,
			current_period_end: "2026-12-01T00:00:00.000Z",
		};
		const billingSummary = vi.fn(async () => summary);
		expect(await call(deps({ billingSummary }), "get_usage", { kind: "billing" })).toEqual({
			kind: "billing",
			usage: {
				hosted: true,
				has_org: true,
				plan: "team",
				status: "active",
				state: "active",
				seats: 5,
				member_count: 3,
				unit_amount: { amount_minor: 1900, currency: "eur" },
				cancel_at_period_end: false,
				current_period_end: "2026-12-01T00:00:00.000Z",
			},
		});
		billingSummary.mockResolvedValue({ ...summary, unit_amount: null, currency: null } as never);
		expect(await call(deps({ billingSummary }), "get_usage", { kind: "billing" })).toMatchObject({
			usage: { unit_amount: null },
		});
	});
});

describe("search_docs", () => {
	it("passes the query and top_k through to the docs search", async () => {
		const searchDocs = vi.fn(async () => ({ results: [{ title: "Connect AWS", heading: null, url: "/docs/aws", snippet: "…" }] }));
		expect(await call(deps({ searchDocs }), "search_docs", { query: "connect aws", top_k: 2 })).toEqual({
			results: [{ title: "Connect AWS", heading: null, url: "/docs/aws", snippet: "…" }],
		});
		expect(searchDocs).toHaveBeenCalledWith({ query: "connect aws", topK: 2 });
	});
});

describe("helpers", () => {
	it("turns a value into plain JSON and refuses one that is not an object", () => {
		expect(toJsonObject({ at: new Date("2026-11-24T00:00:00.000Z"), skip: undefined })).toEqual({ at: "2026-11-24T00:00:00.000Z" });
		expect(() => toJsonObject([1])).toThrow();
	});

	it("answers a timestamp as ISO, or null", () => {
		expect(isoOrNull(undefined)).toBeNull();
		expect(isoOrNull(null)).toBeNull();
		expect(isoOrNull("2026-11-24")).toBe("2026-11-24");
		expect(isoOrNull(new Date("2026-11-24T00:00:00.000Z"))).toBe("2026-11-24T00:00:00.000Z");
	});
});
