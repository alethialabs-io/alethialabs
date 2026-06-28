// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// MCP read tools (lib/ai/tools/read.ts). Each tool wraps a PDP-gated server action;
// the tests mock every action boundary and assert the trimmed/secret-free output
// shapes + present/absent-row branching of each tool's execute handler.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/app/server/actions/aws/identities", () => ({
	getVerifiedCloudIdentities: vi.fn(),
}));
vi.mock("@/app/server/actions/cloud-resources", () => ({
	getCloudIdentityResources: vi.fn(),
}));
vi.mock("@/app/server/actions/clusters", () => ({ getClusters: vi.fn() }));
vi.mock("@/app/server/actions/connectors", () => ({
	getConnectorsWithStatus: vi.fn(),
}));
vi.mock("@/app/server/actions/jobs", () => ({
	getJob: vi.fn(),
	getJobs: vi.fn(),
	getPlanResult: vi.fn(),
}));
vi.mock("@/app/server/actions/runners", () => ({
	getRunnersWithReleases: vi.fn(),
}));
vi.mock("@/app/server/actions/projects", () => ({
	getProject: vi.fn(),
	getProjects: vi.fn(),
}));

import { readTools } from "@/lib/ai/tools/read";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getCloudIdentityResources } from "@/app/server/actions/cloud-resources";
import { getClusters } from "@/app/server/actions/clusters";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getJob, getJobs, getPlanResult } from "@/app/server/actions/jobs";
import { getRunnersWithReleases } from "@/app/server/actions/runners";
import { getProject, getProjects } from "@/app/server/actions/projects";

// Helper: invoke a tool's execute handler regardless of the ai-SDK options arg.
const run = (t: { execute?: unknown }, args: unknown) =>
	(t.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {} as never);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("get_project", () => {
	it("trims project + maps full components when cluster/network present", async () => {
		vi.mocked(getProject).mockResolvedValue({
			project: {
				id: "p1",
				project_name: "alpha",
				status: "ready",
				region: "eu-west-1",
				environment_stage: "prod",
			},
			cloudProvider: "aws",
			components: {
				cluster: {
					cluster_version: "1.30",
					instance_types: ["m5.large"],
					node_min_size: 1,
					node_desired_size: 2,
					node_max_size: 5,
				},
				network: {
					provision_network: true,
					cidr_block: "10.0.0.0/16",
					single_nat_gateway: false,
				},
				dns: { enabled: true },
				databases: [{ name: "db1", engine: "postgres", secret: "nope" }],
				caches: [{ name: "c1", engine: "redis" }],
				queues: [{ name: "q1" }, { name: "q2" }],
				topics: [{ name: "t1" }],
				nosql_tables: [{ name: "n1" }],
				secrets: [{ name: "s1" }],
			},
		} as never);

		const out = (await run(readTools().get_project, {
			projectId: "p1",
		})) as Record<string, unknown>;

		expect(getProject).toHaveBeenCalledWith("p1");
		expect(out).toMatchObject({
			id: "p1",
			name: "alpha",
			status: "ready",
			region: "eu-west-1",
			provider: "aws",
			environment: "prod",
		});
		const comp = out.components as Record<string, unknown>;
		expect(comp.cluster).toEqual({
			version: "1.30",
			instance_types: ["m5.large"],
			node_min: 1,
			node_desired: 2,
			node_max: 5,
		});
		expect(comp.network).toEqual({
			provision: true,
			cidr: "10.0.0.0/16",
			single_nat: false,
		});
		expect(comp.dns_enabled).toBe(true);
		// secret-free: only name+engine survive the trim.
		expect(comp.databases).toEqual([{ name: "db1", engine: "postgres" }]);
		expect(comp.caches).toEqual([{ name: "c1", engine: "redis" }]);
		expect(comp.queues).toEqual(["q1", "q2"]);
		expect(comp.topics).toEqual(["t1"]);
		expect(comp.nosql).toEqual(["n1"]);
		expect(comp.secrets).toEqual(["s1"]);
	});

	it("nulls cluster/network and defaults dns/arrays when components absent", async () => {
		vi.mocked(getProject).mockResolvedValue({
			project: {
				id: "p2",
				project_name: "beta",
				status: "draft",
				region: "us-east-1",
				environment_stage: "dev",
			},
			cloudProvider: "gcp",
			components: {
				cluster: null,
				network: null,
			},
		} as never);

		const out = (await run(readTools().get_project, {
			projectId: "p2",
		})) as Record<string, unknown>;
		const comp = out.components as Record<string, unknown>;
		expect(comp.cluster).toBeNull();
		expect(comp.network).toBeNull();
		expect(comp.dns_enabled).toBe(false);
		expect(comp.databases).toEqual([]);
		expect(comp.caches).toEqual([]);
		expect(comp.queues).toEqual([]);
		expect(comp.secrets).toEqual([]);
	});
});

describe("list_projects", () => {
	it("maps each project to the flat trimmed shape", async () => {
		vi.mocked(getProjects).mockResolvedValue([
			{
				id: "p1",
				project_name: "alpha",
				slug: "alpha",
				status: "ready",
				cloud_provider: "aws",
				region: "eu-west-1",
				environment_stage: "prod",
				extra: "dropped",
			},
		] as never);

		const out = (await run(readTools().list_projects, {})) as {
			projects: Array<Record<string, unknown>>;
		};
		expect(out.projects).toEqual([
			{
				id: "p1",
				name: "alpha",
				slug: "alpha",
				status: "ready",
				provider: "aws",
				region: "eu-west-1",
				environment: "prod",
			},
		]);
	});
});

describe("list_jobs", () => {
	const mkJobs = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			id: `j${i}`,
			job_type: "plan",
			status: "done",
			project_name: "alpha",
			cloud_provider: "aws",
			created_at: "t",
			completed_at: "t2",
		}));

	it("defaults to 20 results when no limit given", async () => {
		vi.mocked(getJobs).mockResolvedValue(mkJobs(30) as never);
		const out = (await run(readTools().list_jobs, {})) as { jobs: unknown[] };
		expect(out.jobs).toHaveLength(20);
	});

	it("honors the limit and trims the job shape", async () => {
		vi.mocked(getJobs).mockResolvedValue(mkJobs(30) as never);
		const out = (await run(readTools().list_jobs, { limit: 3 })) as {
			jobs: Array<Record<string, unknown>>;
		};
		expect(out.jobs).toHaveLength(3);
		expect(out.jobs[0]).toEqual({
			id: "j0",
			type: "plan",
			status: "done",
			project: "alpha",
			provider: "aws",
			created_at: "t",
			completed_at: "t2",
		});
	});
});

describe("get_job", () => {
	it("returns an error object when the job is missing", async () => {
		vi.mocked(getJob).mockResolvedValue(null as never);
		const out = await run(readTools().get_job, { jobId: "x" });
		expect(out).toEqual({ error: "Job not found." });
	});

	it("returns the trimmed job (incl. error_message) when present", async () => {
		vi.mocked(getJob).mockResolvedValue({
			id: "j1",
			job_type: "deploy",
			status: "failed",
			error_message: "boom",
			project_id: "p1",
			created_at: "t",
			completed_at: null,
		} as never);
		const out = await run(readTools().get_job, { jobId: "j1" });
		expect(out).toEqual({
			id: "j1",
			type: "deploy",
			status: "failed",
			error: "boom",
			project_id: "p1",
			created_at: "t",
			completed_at: null,
		});
	});
});

describe("get_plan_result", () => {
	it("returns status, error, and output_keys from execution_metadata", async () => {
		vi.mocked(getPlanResult).mockResolvedValue({
			status: "completed",
			error_message: null,
			execution_metadata: { kubeconfig: "x", endpoint: "y" },
		} as never);
		const out = await run(readTools().get_plan_result, { jobId: "j1" });
		expect(out).toEqual({
			status: "completed",
			error: null,
			output_keys: ["kubeconfig", "endpoint"],
		});
	});

	it("yields empty output_keys when execution_metadata is null", async () => {
		vi.mocked(getPlanResult).mockResolvedValue({
			status: "queued",
			error_message: null,
			execution_metadata: null,
		} as never);
		const out = (await run(readTools().get_plan_result, { jobId: "j2" })) as {
			output_keys: string[];
		};
		expect(out.output_keys).toEqual([]);
	});
});

describe("list_runners", () => {
	it("derives the online boolean from ONLINE status", async () => {
		vi.mocked(getRunnersWithReleases).mockResolvedValue([
			{ id: "r1", name: "a", operator: "managed", status: "ONLINE", version: "1" },
			{ id: "r2", name: "b", operator: "self", status: "OFFLINE", version: "2" },
		] as never);
		const out = (await run(readTools().list_runners, {})) as {
			runners: Array<Record<string, unknown>>;
		};
		expect(out.runners[0].online).toBe(true);
		expect(out.runners[1].online).toBe(false);
		expect(out.runners[0]).toEqual({
			id: "r1",
			name: "a",
			operator: "managed",
			status: "ONLINE",
			version: "1",
			online: true,
		});
	});
});

describe("list_clusters", () => {
	it("maps cluster details + provider when nested rows present", async () => {
		vi.mocked(getClusters).mockResolvedValue([
			{
				id: "c1",
				project_name: "alpha",
				region: "eu-west-1",
				environment_stage: "prod",
				status: "live",
				cloud_identities: { provider: "aws" },
				project_cluster: {
					cluster_name: "k8s",
					cluster_endpoint: "https://x",
					cluster_version: "1.30",
					argocd_url: "https://argo",
					status: "ready",
				},
				project_databases: [{ name: "db", engine: "postgres", endpoint: "e" }],
				project_caches: [{ name: "ca", engine: "redis" }],
				project_dns: { domain_name: "ex.com", enabled: true },
			},
		] as never);
		const out = (await run(readTools().list_clusters, {})) as {
			clusters: Array<Record<string, unknown>>;
		};
		const c = out.clusters[0];
		expect(c.provider).toBe("aws");
		expect(c.cluster).toEqual({
			name: "k8s",
			endpoint: "https://x",
			version: "1.30",
			argocd_url: "https://argo",
			status: "ready",
		});
		expect(c.databases).toEqual([
			{ name: "db", engine: "postgres", endpoint: "e" },
		]);
		expect(c.dns).toEqual({ domain: "ex.com", enabled: true });
	});

	it("nulls provider/cluster/dns and empties arrays when nested rows absent", async () => {
		vi.mocked(getClusters).mockResolvedValue([
			{
				id: "c2",
				project_name: "beta",
				region: "us-east-1",
				environment_stage: "dev",
				status: "pending",
			},
		] as never);
		const out = (await run(readTools().list_clusters, {})) as {
			clusters: Array<Record<string, unknown>>;
		};
		const c = out.clusters[0];
		expect(c.provider).toBeNull();
		expect(c.cluster).toBeNull();
		expect(c.dns).toBeNull();
		expect(c.databases).toEqual([]);
		expect(c.caches).toEqual([]);
	});
});

describe("list_connectors", () => {
	it("maps connectors to the trimmed status shape", async () => {
		vi.mocked(getConnectorsWithStatus).mockResolvedValue([
			{
				slug: "datadog",
				name: "Datadog",
				category: "observability",
				status: "connected",
				connected: true,
				token_health: "ok",
				secret: "dropped",
			},
		] as never);
		const out = (await run(readTools().list_connectors, {})) as {
			connectors: Array<Record<string, unknown>>;
		};
		expect(out.connectors).toEqual([
			{
				slug: "datadog",
				name: "Datadog",
				category: "observability",
				status: "connected",
				connected: true,
				token_health: "ok",
			},
		]);
	});
});

describe("list_cloud_identities", () => {
	it("wraps the verified identities under an identities key", async () => {
		const identities = [{ id: "ci1", name: "prod", displayId: "1234", provider: "aws" }];
		vi.mocked(getVerifiedCloudIdentities).mockResolvedValue(identities as never);
		const out = await run(readTools().list_cloud_identities, {});
		expect(out).toEqual({ identities });
	});
});

describe("get_cached_resources", () => {
	it("passes the id through and returns the action result verbatim", async () => {
		const resources = { vpcs: [{ id: "vpc-1" }], regions: ["eu-west-1"] };
		vi.mocked(getCloudIdentityResources).mockResolvedValue(resources as never);
		const out = await run(readTools().get_cached_resources, {
			cloudIdentityId: "ci1",
		});
		expect(getCloudIdentityResources).toHaveBeenCalledWith("ci1");
		expect(out).toBe(resources);
	});
});
