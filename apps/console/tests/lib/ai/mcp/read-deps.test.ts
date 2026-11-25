// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The default dependencies of the declared reads (lib/ai/mcp/read-deps.ts): each one runs the in-app
// tool its contract entry `replaces`, with that tool's own input names, and a cloud this deployment
// does not offer is refused before any catalog tool runs. The in-app tools are stood in; what is
// asserted is the wiring.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/jobs", () => ({ getJobs: vi.fn() }));
vi.mock("@/app/server/actions/projects", () => ({ getProjectAsFormData: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/ai/mcp/design-store", () => ({ readDesignRevision: vi.fn() }));
vi.mock("@/lib/ai/mcp/plan-facts", () => ({ readPlanFacts: vi.fn() }));
vi.mock("@/lib/ai/mcp/in-app", () => ({ runInAppTool: vi.fn(async (name: string, tool: string, input: unknown) => ({ name, tool, input })) }));
/** A tool set whose every tool is its own name, so the test can see which one ran. */
const { named } = vi.hoisted(() => ({
	named:
		(...names: string[]) =>
		() =>
			Object.fromEntries(names.map((n) => [n, `tool:${n}`])),
}));
vi.mock("@/lib/ai/tools/read", () => ({
	readTools: named(
		"list_projects",
		"list_runners",
		"list_clusters",
		"list_connectors",
		"list_cloud_identities",
		"get_project",
		"get_job",
		"get_drift_posture",
		"get_cached_resources",
		"get_plan_result",
		"get_org_usage",
		"get_ai_usage",
		"get_billing_summary",
	),
}));
vi.mock("@/lib/ai/tools/compose", () => ({
	catalogTools: named("list_services", "list_service_options", "cidr_for_hosts"),
	offeredProvisioningClouds: () => ["aws", "hetzner"],
}));
vi.mock("@/lib/ai/tools/docs", () => ({ docsTools: named("search_docs") }));
vi.mock("@/lib/ai/tools/scanner", () => ({ scannerTools: named("get_scan_result", "compare_providers") }));

import { getJobs } from "@/app/server/actions/jobs";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { readDesignRevision } from "@/lib/ai/mcp/design-store";
import { readPlanFacts } from "@/lib/ai/mcp/plan-facts";
import { defaultReadDeps, offeredCloud } from "@/lib/ai/mcp/read-deps";
import { currentActor } from "@/lib/authz/guard";

beforeEach(() => vi.clearAllMocks());

/** What a stood-in in-app run answered: the tool name, the tool and the input. */
function ran(name: string, input: unknown) {
	return { name, tool: `tool:${name}`, input };
}

describe("defaultReadDeps — the in-app tools each read runs", () => {
	it("runs the list and get tools with their own input names", async () => {
		const d = defaultReadDeps;
		expect(await d.listProjects()).toEqual(ran("list_projects", {}));
		expect(await d.listRunners()).toEqual(ran("list_runners", {}));
		expect(await d.listClusters()).toEqual(ran("list_clusters", {}));
		expect(await d.listConnectors()).toEqual(ran("list_connectors", {}));
		expect(await d.listCloudIdentities()).toEqual(ran("list_cloud_identities", {}));
		expect(await d.getProject("p1")).toEqual(ran("get_project", { projectId: "p1" }));
		expect(await d.getJob("j1")).toEqual(ran("get_job", { jobId: "j1" }));
		expect(await d.getDrift("p1", "e1")).toEqual(ran("get_drift_posture", { projectId: "p1", environmentId: "e1" }));
		expect(await d.getCloudInventory("ci1")).toEqual(ran("get_cached_resources", { cloudIdentityId: "ci1" }));
		expect(await d.getScan("s1")).toEqual(ran("get_scan_result", { jobId: "s1" }));
		expect(await d.getPlanResult("plan-1")).toEqual(ran("get_plan_result", { jobId: "plan-1" }));
		expect(await d.compareProviders("s1")).toEqual(ran("compare_providers", { jobId: "s1" }));
		expect(await d.orgUsage()).toEqual(ran("get_org_usage", {}));
		expect(await d.aiUsage()).toEqual(ran("get_ai_usage", {}));
		expect(await d.billingSummary()).toEqual(ran("get_billing_summary", {}));
		expect(await d.searchDocs({ query: "q", topK: 3 })).toEqual(ran("search_docs", { query: "q", topK: 3 }));
		expect(await d.listServices()).toEqual(ran("list_services", {}));
	});

	it("runs the catalog tools only with an offered cloud", async () => {
		const d = defaultReadDeps;
		expect(await d.listServiceOptions("hetzner")).toEqual(ran("list_service_options", { provider: "hetzner" }));
		expect(await d.cidrForHosts({ hosts: 10, cloud: "aws" })).toEqual(ran("cidr_for_hosts", { hosts: 10, base: undefined, cloud: "aws" }));
		expect(await d.cidrForHosts({ hosts: 10, base: "10.1.0.0" })).toEqual(
			ran("cidr_for_hosts", { hosts: 10, base: "10.1.0.0", cloud: undefined }),
		);
		await expect(d.listServiceOptions("oracle")).rejects.toMatchObject({ code: "invalid_input" });
		expect(() => offeredCloud("oracle")).toThrow("Pass one of: aws, hetzner.");
	});
});

describe("defaultReadDeps — the direct reads", () => {
	it("lists jobs with the project id, ISO timestamps and the contract's names", async () => {
		vi.mocked(getJobs).mockResolvedValue([
			{
				id: "j1",
				job_type: "PLAN",
				status: "SUCCESS",
				project_name: "api",
				project_id: "p1",
				environment_id: "e1",
				cloud_provider: "aws",
				created_at: new Date("2026-11-24T10:00:00.000Z"),
				completed_at: null,
			},
		] as never);
		expect(await defaultReadDeps.listJobs()).toEqual([
			{
				id: "j1",
				type: "PLAN",
				status: "SUCCESS",
				project: "api",
				project_id: "p1",
				environment_id: "e1",
				provider: "aws",
				created_at: "2026-11-24T10:00:00.000Z",
				completed_at: null,
			},
		]);
	});

	it("reads the design through getProjectAsFormData, without a stored credential, and the revision as the caller", async () => {
		const formData = {
			project: { project_name: "api" },
			databases: [{ name: "orders", provider_config: { rds_extra_credentials: { u: "hunter2" }, instance_class: "db.t3.micro" } }],
			secrets: [{ name: "api-key", provider_config: { value: "s3cr3t" } }],
		};
		vi.mocked(getProjectAsFormData).mockResolvedValue({ formData, provider: "aws" } as never);
		const design = await defaultReadDeps.readDesign("p1", "e1");
		expect(getProjectAsFormData).toHaveBeenCalledWith("p1", "e1");
		expect(JSON.stringify(design)).not.toMatch(/hunter2|s3cr3t/);
		expect(design).toMatchObject({ databases: [{ name: "orders", provider_config: { instance_class: "db.t3.micro" } }] });
		// The stored design itself is untouched: only the copy handed back is stripped.
		expect(formData.databases[0].provider_config.rds_extra_credentials).toEqual({ u: "hunter2" });

		const actor = { userId: "user-1", orgId: "org-1" };
		vi.mocked(currentActor).mockResolvedValue(actor as never);
		vi.mocked(readDesignRevision).mockResolvedValue(42);
		expect(await defaultReadDeps.designRevision("p1")).toBe(42);
		expect(readDesignRevision).toHaveBeenCalledWith(actor, "p1");
	});

	it("reads the plan facts through readPlanFacts", () => {
		expect(defaultReadDeps.planFacts).toBe(readPlanFacts);
	});
});
