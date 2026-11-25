// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The external tool contract (lib/ai/mcp/surface.ts) is data; the server (lib/ai/mcp/server.ts) serves
// part of it. The tests here are what stop it from drifting away from the things it describes:
//
//   1. THE LIVE SURFACE. Every declared tool has a handler (`HANDLED_TOOL_NAMES`), so the server lists
//      exactly the declared tools (tests/lib/ai/mcp/server.test.ts asserts the listing: 19 tools, 12
//      under `?readonly`). Each declared read answers through the in-app tools it `replaces`, and
//      those are exactly the tools of the external in-app projection (`buildExternalAgentTools()`).
//   2. THE RULES. Every declared tool passes `toolContractViolations`, and a tool missing a scope
//      or an annotation is refused by it.
//   3. THE SCHEMAS. Each one is an object at the JSON Schema root, and a sample of every
//      per-kind shape survives its tool's output schema unchanged.
//   4. THE DOCUMENT. `lib/ai/TOOLS.md` carries exactly the table the contract renders.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/aws/identities");
vi.mock("@/app/server/actions/cloud-resources");
vi.mock("@/app/server/actions/clusters");
vi.mock("@/app/server/actions/connectors");
vi.mock("@/app/server/actions/jobs");
vi.mock("@/lib/rpc/procedures/jobs");
vi.mock("@/lib/pricing/region-prices");
vi.mock("@/app/server/actions/projects");
vi.mock("@/app/server/actions/runners");
vi.mock("@/app/server/actions/scanner");
vi.mock("@/lib/rpc/procedures/projects");
vi.mock("@/lib/ai/mcp/approval-store", () => ({
	findOwnApproval: vi.fn(),
	requestOwnApproval: vi.fn(),
	readOwnOrgApproval: vi.fn(),
	appliedPlanFor: vi.fn(),
}));
vi.mock("@/lib/ai/mcp/job-logs", () => ({ readJobLogPage: vi.fn() }));
vi.mock("@/lib/ai/mcp/feedback", () => ({ sendAgentFeedback: vi.fn() }));

import { HANDLED_TOOL_NAMES } from "@/lib/ai/mcp/handlers";
import {
	AGENT_SCOPES,
	EXTERNAL_TOOLS,
	LIST_ITEM_SCHEMAS,
	RESOURCE_SCHEMAS,
	TOOL_GROUPS,
	USAGE_SCHEMAS,
	listExternalTools,
	parseSurfaceQuery,
	renderToolTable,
	selectExternalTools,
	toolContractViolations,
	type AgentScope,
	type ExternalToolName,
	type SurfaceQuery,
	type ToolContractCandidate,
} from "@/lib/ai/mcp/surface";
import { buildExternalAgentTools } from "@/lib/ai/tools";
import { isExternalTool } from "@/lib/ai/tools/registry";

/** The seven tools `?readonly` removes, in listing order. */
const WRITE_TOOLS: ExternalToolName[] = [
	"apply_design_patch",
	"create_project",
	"scan_repo",
	"plan",
	"request_apply",
	"request_destroy",
	"cancel_job",
];

/** The query a URL with no scoping parameters parses to. */
const UNSCOPED: SurfaceQuery = { readonly: false, projectId: null, features: null };

/** Parses a query string and returns the query, failing the test if it was refused. */
function parsed(search: string): SurfaceQuery {
	const result = parseSurfaceQuery(new URLSearchParams(search));
	if (!result.ok) throw new Error(`expected "${search}" to parse, got: ${result.error}`);
	return result.query;
}

/** Parses a query string and returns the refusal, failing the test if it was accepted. */
function refusal(search: string): string {
	const result = parseSurfaceQuery(new URLSearchParams(search));
	if (result.ok) throw new Error(`expected "${search}" to be refused`);
	return result.error;
}

/** The names a tool selection lists. */
function names(tools: { name: string }[]): string[] {
	return tools.map((tool) => tool.name);
}

describe("external tool contract — the live surface", () => {
	it("has a handler for every declared tool, and none for anything undeclared", () => {
		expect(HANDLED_TOOL_NAMES).toHaveLength(19);
		expect([...HANDLED_TOOL_NAMES].sort()).toEqual(Object.keys(EXTERNAL_TOOLS).sort());
	});

	it("stands for exactly the tools of the external in-app projection", () => {
		const projected = Object.keys(buildExternalAgentTools());
		const declared = listExternalTools().flatMap((tool) => [...tool.replaces]);

		// Non-vacuous: the projection really does hold a read surface.
		expect(projected.length).toBeGreaterThan(0);
		expect([...declared].sort()).toEqual([...projected].sort());
	});

	it("gives each in-app tool one home, on a read tool, and only if it is externally visible", () => {
		const declared = listExternalTools().flatMap((tool) => [...tool.replaces]);
		expect(new Set(declared).size).toBe(declared.length);

		const standIns = listExternalTools().filter((tool) => tool.replaces.length > 0);
		expect(standIns.map((tool) => tool.kind)).toEqual(standIns.map(() => "read"));
		expect(declared.filter((inApp) => !isExternalTool(inApp))).toEqual([]);
	});
});

describe("external tool contract — the declared tools", () => {
	it("declares 19 tools: 11 reads, 7 writes and feedback", () => {
		const tools = listExternalTools();
		expect(tools).toHaveLength(19);
		expect(names(tools)).toEqual(Object.keys(EXTERNAL_TOOLS));
		expect(names(tools.filter((tool) => tool.kind === "write"))).toEqual(WRITE_TOOLS);
		expect(names(tools.filter((tool) => tool.kind === "meta"))).toEqual(["send_feedback"]);
		expect(tools.filter((tool) => tool.kind === "read")).toHaveLength(11);
	});

	it("breaks no contract rule", () => {
		const broken = listExternalTools()
			.map((tool) => ({ name: tool.name, violations: toolContractViolations(tool.name, tool) }))
			.filter((entry) => entry.violations.length > 0);
		expect(broken).toEqual([]);
	});

	it("uses only declared scopes and groups, and every scope and group is used", () => {
		const tools = listExternalTools();
		const scopes = new Set(tools.map((tool) => tool.scope).filter((scope) => scope !== null));
		expect([...scopes].sort()).toEqual([...AGENT_SCOPES].sort());
		expect([...new Set(tools.map((tool) => tool.group))].sort()).toEqual([...TOOL_GROUPS].sort());
	});

	it("gates each write behind the scope the spec names", () => {
		const scopeOf = Object.fromEntries(
			listExternalTools().map((tool) => [tool.name, tool.scope]),
		);
		expect(scopeOf).toMatchObject({
			apply_design_patch: "design",
			create_project: "design",
			scan_repo: "plan",
			plan: "plan",
			cancel_job: "plan",
			request_apply: "apply",
			request_destroy: "destroy",
			send_feedback: null,
		});
	});

	it("marks the approval requests destructive and every read non-destructive", () => {
		expect(EXTERNAL_TOOLS.request_apply.annotations.destructiveHint).toBe(true);
		expect(EXTERNAL_TOOLS.request_destroy.annotations.destructiveHint).toBe(true);
		const reads = listExternalTools().filter((tool) => tool.kind === "read");
		expect(reads.map((tool) => ({ name: tool.name, ...tool.annotations }))).toEqual(
			reads.map((tool) => ({
				name: tool.name,
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			})),
		);
	});

	it("requires an idempotency key on every write that creates something", () => {
		const keyed = listExternalTools()
			.filter((tool) => "idempotency_key" in tool.inputSchema.shape)
			.map((tool) => tool.name);
		expect(keyed).toEqual(["apply_design_patch", "create_project", "scan_repo", "plan"]);
	});
});

describe("external tool contract — toolContractViolations", () => {
	const annotations = {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	};

	it("accepts a complete write tool", () => {
		expect(toolContractViolations("do_thing", { kind: "write", scope: "plan", annotations })).toEqual(
			[],
		);
	});

	it("refuses a write tool with no scope", () => {
		const noScope: ToolContractCandidate = { kind: "write", annotations };
		const readScope: ToolContractCandidate = { kind: "write", scope: "read", annotations };
		const nullScope: ToolContractCandidate = { kind: "write", scope: null, annotations };
		for (const candidate of [noScope, readScope, nullScope]) {
			expect(toolContractViolations("do_thing", candidate)).toEqual([
				"a write tool must require one of design, plan, apply, destroy",
			]);
		}
	});

	it("refuses a tool with no annotations, naming every missing hint", () => {
		expect(toolContractViolations("do_thing", { kind: "write", scope: "plan" })).toEqual([
			"annotations must state readOnlyHint, destructiveHint, idempotentHint, openWorldHint",
		]);
	});

	it("refuses a tool that leaves one hint to the protocol default", () => {
		expect(
			toolContractViolations("do_thing", {
				kind: "write",
				scope: "plan",
				annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
			}),
		).toEqual(["annotations must state destructiveHint"]);
	});

	it("refuses a write tool that calls itself read-only", () => {
		expect(
			toolContractViolations("do_thing", {
				kind: "write",
				scope: "plan",
				annotations: { ...annotations, readOnlyHint: true },
			}),
		).toEqual(["a write tool must not set readOnlyHint to true"]);
	});

	it("refuses a read tool with another scope or without the read-only hint", () => {
		expect(toolContractViolations("see_thing", { kind: "read", scope: "plan", annotations })).toEqual([
			"a read tool must require the read scope",
			"a read tool must not set readOnlyHint to false",
		]);
	});

	it("refuses a meta tool that requires a scope, and accepts one that does not", () => {
		expect(toolContractViolations("note", { kind: "meta", scope: "read", annotations })).toEqual([
			"a meta tool must not require a scope",
		]);
		expect(toolContractViolations("note", { kind: "meta", scope: null, annotations })).toEqual([]);
		expect(toolContractViolations("note", { kind: "meta", annotations })).toEqual([]);
	});

	it("refuses a name the protocol does not allow", () => {
		for (const name of ["", "has space", "comma,name", "x".repeat(129)]) {
			expect(toolContractViolations(name, { kind: "meta", annotations })).toEqual([
				"name must be 1 to 128 characters of A-Z a-z 0-9 _ - .",
			]);
		}
		expect(toolContractViolations("x".repeat(128), { kind: "meta", annotations })).toEqual([]);
		expect(toolContractViolations("admin.tools-v2_list", { kind: "meta", annotations })).toEqual([]);
	});

	it("refuses a name on the AI tool denylist", () => {
		expect(
			toolContractViolations("get_kubeconfig", {
				kind: "read",
				scope: "read",
				annotations: { ...annotations, readOnlyHint: true },
			}),
		).toEqual(["name is on the AI tool denylist"]);
	});
});

describe("external tool contract — schemas", () => {
	it("every input and output schema is an object at the JSON Schema root", () => {
		const tools = listExternalTools();
		const roots = tools.map((tool) => ({
			name: tool.name,
			inputIsObject: tool.inputSchema instanceof z.ZodObject,
			outputIsObject: tool.outputSchema instanceof z.ZodObject,
			input: z.toJSONSchema(tool.inputSchema, { io: "input" }).type,
			output: z.toJSONSchema(tool.outputSchema, { io: "output" }).type,
		}));
		expect(roots).toEqual(
			tools.map((tool) => ({
				name: tool.name,
				inputIsObject: true,
				outputIsObject: true,
				input: "object",
				output: "object",
			})),
		);
	});

	it("every tool has a title and a description, and names its arguments in snake_case", () => {
		const tools = listExternalTools();
		expect(tools.filter((tool) => tool.title.length === 0).map((tool) => tool.name)).toEqual([]);
		expect(
			tools.filter((tool) => tool.description.length <= 20).map((tool) => tool.name),
		).toEqual([]);
		const badArguments = tools.flatMap((tool) =>
			Object.keys(tool.inputSchema.shape)
				.filter((key) => !/^[a-z][a-z0-9_]*$/.test(key))
				.map((key) => `${tool.name}.${key}`),
		);
		expect(badArguments).toEqual([]);
	});

	it("wait_for_job takes exactly one of job_id and approval_id, and at most 50 seconds", () => {
		const input = EXTERNAL_TOOLS.wait_for_job.inputSchema;
		expect(input.safeParse({ job_id: "j1" }).success).toBe(true);
		expect(input.safeParse({ approval_id: "a1", timeout_s: 50 }).success).toBe(true);
		expect(input.safeParse({}).success).toBe(false);
		expect(input.safeParse({ job_id: "j1", approval_id: "a1" }).success).toBe(false);
		expect(input.safeParse({ job_id: "j1", timeout_s: 51 }).success).toBe(false);
	});

	it("an approval request returns its status, an 8-character digest prefix, and a job only once consumed", () => {
		const output = EXTERNAL_TOOLS.request_apply.outputSchema;
		const pending = {
			approval_id: "apr_1",
			status: "pending",
			approve_url: "https://console.example/approvals/apr_1",
			digest_prefix: "9f3c1a7e",
			expires_at: "2026-11-17T12:00:00Z",
			job_id: null,
		};
		expect(output.parse(pending)).toEqual(pending);
		expect(output.parse({ ...pending, status: "consumed", job_id: "job_1" }).job_id).toBe("job_1");
		expect(output.safeParse({ ...pending, digest_prefix: "9f3c" }).success).toBe(false);
		expect(output.safeParse({ ...pending, status: "queued" }).success).toBe(false);
		expect(EXTERNAL_TOOLS.request_destroy.outputSchema).toBe(output);
	});

	it("request_apply names a plan; request_destroy names the environment, whose applied plan the server finds", () => {
		expect(Object.keys(EXTERNAL_TOOLS.request_apply.inputSchema.shape)).toEqual(["plan_job_id", "reason"]);
		expect(Object.keys(EXTERNAL_TOOLS.request_destroy.inputSchema.shape)).toEqual([
			"project_id",
			"environment_id",
			"reason",
		]);
	});

	it("tells the calling model, in each approval tool, that a person approves and no tool does", () => {
		for (const name of ["request_apply", "request_destroy"] as const) {
			const { description } = EXTERNAL_TOOLS[name];
			expect(description).toContain("No tool approves");
			expect(description).toContain("wait_for_job");
			expect(description).toContain("call request_");
		}
	});

	it("apply_design_patch takes add, remove and replace operations and at least one of them", () => {
		const input = EXTERNAL_TOOLS.apply_design_patch.inputSchema;
		const base = { project_id: "p1", base_revision: 3, idempotency_key: "key-12345" };
		const op = { op: "replace", path: "/cluster/node_max", value: 5 };
		expect(input.safeParse({ ...base, patch: [op] }).success).toBe(true);
		expect(input.safeParse({ ...base, patch: [] }).success).toBe(false);
		expect(input.safeParse({ ...base, patch: [{ ...op, op: "move" }] }).success).toBe(false);
		expect(input.safeParse({ ...base, patch: [op], idempotency_key: "short" }).success).toBe(false);
	});

	it("validate_design accepts any JSON object, so problems come back as data", () => {
		const input = EXTERNAL_TOOLS.validate_design.inputSchema;
		expect(input.safeParse({ design: { anything: [1, "two", null, { deep: true }] } }).success).toBe(
			true,
		);
		expect(input.safeParse({ design: "not an object" }).success).toBe(false);
	});

	it("each list_resources item shape survives the tool's output schema unchanged", () => {
		const samples = {
			project: {
				id: "p1",
				name: "api",
				slug: "api",
				status: "ACTIVE",
				provider: "hetzner",
				region: "fsn1",
				environment: "staging",
			},
			job: {
				id: "j1",
				type: "PLAN",
				status: "SUCCESS",
				project: "api",
				environment_id: "e1",
				provider: "hetzner",
				created_at: "2026-11-17T10:00:00Z",
				completed_at: null,
			},
			runner: {
				id: "r1",
				name: "runner-1",
				operator: "managed",
				status: "ONLINE",
				version: "1.2.3",
				online: true,
			},
			cluster: {
				id: "c1",
				project_id: "p1",
				name: "api",
				region: "fsn1",
				environment: "staging",
				status: "ACTIVE",
				provider: "hetzner",
				cluster: {
					name: "api-staging",
					endpoint: "https://10.0.0.1:6443",
					version: "1.33",
					argocd_url: null,
					status: "ACTIVE",
				},
				databases: [{ name: "main", engine: "postgres", endpoint: null }],
				caches: [{ name: "cache", engine: "valkey" }],
				dns: { domain: "example.com", enabled: true },
			},
			connector: {
				slug: "github",
				name: "GitHub",
				category: "git",
				status: "available",
				connected: false,
				token_health: null,
			},
			cloud_identity: { id: "ci1", name: "prod", display_id: "1234", provider: "aws" },
		} satisfies Record<keyof typeof LIST_ITEM_SCHEMAS, object>;

		expect(Object.keys(samples).sort()).toEqual(Object.keys(LIST_ITEM_SCHEMAS).sort());
		const output = EXTERNAL_TOOLS.list_resources.outputSchema;
		for (const [kind, item] of Object.entries(samples)) {
			const result = { kind, items: [item], truncated: false };
			expect(output.parse(result)).toEqual(result);
		}
		// A field that belongs to no kind is refused rather than dropped.
		expect(
			output.safeParse({
				kind: "runner",
				items: [{ ...samples.runner, token: "secret" }],
				truncated: false,
			}).success,
		).toBe(false);
	});

	it("each get_resource shape survives the tool's output schema unchanged", () => {
		const samples = {
			project: {
				id: "p1",
				name: "api",
				status: "ACTIVE",
				region: "fsn1",
				provider: "hetzner",
				environment: "staging",
				components: { cluster: { version: "1.33" }, databases: [] },
			},
			design: {
				project_id: "p1",
				environment_id: "e1",
				revision: 4,
				design: { nodes: [], edges: [] },
			},
			job: {
				id: "j1",
				type: "PLAN",
				status: "FAILED",
				error: "boom",
				project_id: "p1",
				created_at: "2026-11-17T10:00:00Z",
				completed_at: "2026-11-17T10:02:00Z",
			},
			drift: { has_data: true, in_sync: false, drifted: [{ address: "x" }], scanned_at: null },
			cloud_inventory: { cloud_identity_id: "ci1", inventory: { networks: [] } },
			scan: { scan_status: "PENDING", stack: null, proposed: null },
		} satisfies Record<keyof typeof RESOURCE_SCHEMAS, object>;

		expect(Object.keys(samples).sort()).toEqual(Object.keys(RESOURCE_SCHEMAS).sort());
		const output = EXTERNAL_TOOLS.get_resource.outputSchema;
		for (const [kind, resource] of Object.entries(samples)) {
			const result = { kind, resource };
			expect(output.parse(result)).toEqual(result);
		}
	});

	it("each get_usage shape survives the tool's output schema unchanged", () => {
		const samples = {
			runner_minutes: {
				plan: "team",
				used_minutes: 47,
				included_minutes: 200,
				overage_minutes: 0,
				overage_cost: { amount_minor: 0, currency: "usd" },
				running_jobs: 1,
				max_concurrent_jobs: 2,
				period_start: "2026-11-01T00:00:00Z",
				period_end: "2026-12-01T00:00:00Z",
			},
			ai: {
				enabled: true,
				tier: "pro",
				session_used: 1,
				session_budget: 10,
				session_reset_at: null,
				weekly_used: 3,
				weekly_budget: 50,
				weekly_reset_at: "2026-11-23T00:00:00Z",
				purchased_balance: null,
			},
			billing: {
				hosted: true,
				has_org: true,
				plan: "team",
				status: "active",
				state: "active",
				seats: 5,
				member_count: 4,
				unit_amount: { amount_minor: 2900, currency: "eur" },
				cancel_at_period_end: false,
				current_period_end: "2026-12-01T00:00:00Z",
			},
		} satisfies Record<keyof typeof USAGE_SCHEMAS, object>;

		expect(Object.keys(samples).sort()).toEqual(Object.keys(USAGE_SCHEMAS).sort());
		const output = EXTERNAL_TOOLS.get_usage.outputSchema;
		for (const [kind, usage] of Object.entries(samples)) {
			const result = { kind, usage };
			expect(output.parse(result)).toEqual(result);
		}
	});
});

describe("external tool contract — URL scoping", () => {
	it("parses a URL with no scoping parameters to the unscoped query", () => {
		expect(parsed("")).toEqual(UNSCOPED);
	});

	it("turns readonly on for the bare parameter and off only for false or 0", () => {
		expect(parsed("readonly").readonly).toBe(true);
		expect(parsed("readonly=true").readonly).toBe(true);
		expect(parsed("readonly=1").readonly).toBe(true);
		expect(parsed("readonly=false").readonly).toBe(false);
		expect(parsed("readonly=0").readonly).toBe(false);
	});

	it("reads the project pin and the feature groups", () => {
		expect(parsed("project=p1&features=design,%20jobs")).toEqual({
			readonly: false,
			projectId: "p1",
			features: ["design", "jobs"],
		});
	});

	it("refuses an unknown or empty feature list and an empty project", () => {
		expect(refusal("features=design,nope")).toContain("features must be");
		expect(refusal("features=")).toContain("features must be");
		expect(refusal("project=")).toBe("project must name a project id.");
		expect(refusal("project=%20")).toBe("project must name a project id.");
	});

	it("lists all 19 tools to a token with every scope", () => {
		expect(selectExternalTools({ query: UNSCOPED, scopes: AGENT_SCOPES })).toHaveLength(19);
	});

	it("lists 12 tools under readonly, none of them a write", () => {
		const listed = selectExternalTools({
			query: { ...UNSCOPED, readonly: true },
			scopes: AGENT_SCOPES,
		});
		expect(listed).toHaveLength(12);
		expect(names(listed).filter((name) => WRITE_TOOLS.some((write) => write === name))).toEqual([]);
		expect(names(listed)).toContain("send_feedback");
	});

	it("lists a read-scoped token the same 12 tools without readonly", () => {
		const readScope: AgentScope[] = ["read"];
		expect(names(selectExternalTools({ query: UNSCOPED, scopes: readScope }))).toEqual(
			names(selectExternalTools({ query: { ...UNSCOPED, readonly: true }, scopes: AGENT_SCOPES })),
		);
	});

	it("lists a write only to a token carrying that write's scope", () => {
		const planOnly = names(selectExternalTools({ query: UNSCOPED, scopes: ["read", "plan"] }));
		expect(planOnly).toContain("plan");
		expect(planOnly).toContain("cancel_job");
		expect(planOnly).not.toContain("request_apply");
		expect(planOnly).not.toContain("request_destroy");
		expect(planOnly).not.toContain("create_project");

		const noScopes = names(selectExternalTools({ query: UNSCOPED, scopes: [] }));
		expect(noScopes).toEqual(["send_feedback"]);
	});

	it("narrows the list to the named feature groups, in listing order", () => {
		const listed = selectExternalTools({
			query: { ...UNSCOPED, features: ["jobs", "docs"] },
			scopes: AGENT_SCOPES,
		});
		expect(names(listed)).toEqual(["search_docs", "wait_for_job", "get_job_logs", "cancel_job"]);
	});
});

describe("external tool contract — TOOLS.md", () => {
	it("carries exactly the table the contract renders", () => {
		const doc = readFileSync(join(__dirname, "../../../../lib/ai/TOOLS.md"), "utf8");
		const start = "<!-- external-tools:start -->\n";
		const end = "\n<!-- external-tools:end -->";
		const from = doc.indexOf(start);
		const to = doc.indexOf(end);

		expect(from).toBeGreaterThanOrEqual(0);
		expect(to).toBeGreaterThan(from);
		expect(doc.slice(from + start.length, to)).toBe(renderToolTable());
	});
});
