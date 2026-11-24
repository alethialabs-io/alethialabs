// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The MCP server one request is answered by (lib/ai/mcp/server.ts), with the SDK's McpServer stood
// in by a recorder: what it lists for a token's scopes and the URL's scoping, how a call's result and
// refusal come back, that each call is recorded without its arguments, and that the scope is checked
// again when a tool is called.

import { describe, expect, it, vi } from "vitest";

interface Registered {
	name: string;
	config: { title?: string; description?: string; annotations?: unknown; outputSchema?: unknown };
	cb: (args: unknown) => Promise<{ isError?: boolean; structuredContent?: unknown; content: { text: string }[] }>;
}
const registered: Registered[] = [];
const instructions: string[] = [];

vi.mock("@modelcontextprotocol/server", () => ({
	McpServer: class {
		constructor(_info: unknown, options: { instructions: string }) {
			instructions.push(options.instructions);
		}
		registerTool(name: string, config: Registered["config"], cb: Registered["cb"]) {
			registered.push({ name, config, cb });
		}
	},
}));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/lib/ai/mcp/handlers", async () => {
	const actual = await vi.importActual<typeof import("@/lib/ai/mcp/handlers")>("@/lib/ai/mcp/handlers");
	return { ...actual, createHandlers: () => ({ plan: { scope: "plan", call: vi.fn(async () => ({ job_id: "j" })) } }) };
});
vi.mock("@/lib/ai/mcp/reads", async () => {
	const actual = await vi.importActual<typeof import("@/lib/ai/mcp/reads")>("@/lib/ai/mcp/reads");
	return { ...actual, createReadHandlers: () => ({ catalog: { scope: "read", call: vi.fn(async () => ({})) } }) };
});
vi.mock("@/lib/ai/mcp/design", async () => {
	const actual = await vi.importActual<typeof import("@/lib/ai/mcp/design")>("@/lib/ai/mcp/design");
	return { ...actual, createDesignHandlers: () => ({ validate_design: { scope: "read", call: vi.fn(async () => ({})) } }) };
});
vi.mock("@/lib/ai/mcp/read-deps", () => ({ defaultReadDeps: {} }));
vi.mock("@/lib/ai/mcp/design-deps", () => ({ defaultDesignDeps: {} }));
vi.mock("@/lib/ai/mcp/feedback", () => ({ sendAgentFeedback: vi.fn() }));
vi.mock("@/app/server/actions/projects", () => ({ planProject: vi.fn(), provisionProject: vi.fn(), destroyProject: vi.fn() }));
vi.mock("@/app/server/actions/jobs", () => ({ cancelJob: vi.fn() }));
vi.mock("@/app/server/actions/scanner", () => ({ scanRepo: vi.fn() }));
vi.mock("@/lib/rpc/procedures/jobs", () => ({ readJobStatus: vi.fn() }));
vi.mock("@/lib/ai/mcp/approval-store", () => ({
	findOwnApproval: vi.fn(),
	requestOwnApproval: vi.fn(),
	readOwnOrgApproval: vi.fn(),
	appliedPlanFor: vi.fn(),
}));
vi.mock("@/lib/ai/mcp/job-logs", () => ({ readJobLogPage: vi.fn() }));

import { HANDLED_TOOL_NAMES } from "@/lib/ai/mcp/handlers";
import { type HandledTool, McpToolRefusal } from "@/lib/ai/mcp/served";
import {
	buildMcpServer,
	defaultServedTools,
	MCP_SERVER_INSTRUCTIONS,
	recordToolCall,
	type ToolCallRecord,
} from "@/lib/ai/mcp/server";
import { type AgentScope, EXTERNAL_TOOLS, type SurfaceQuery } from "@/lib/ai/mcp/surface";
import type { Actor } from "@/lib/authz/types";
import { withActorScope } from "@/lib/db";
import { log } from "@/lib/observability/log";

const UNSCOPED: SurfaceQuery = { readonly: false, projectId: null, features: null };

/** An actor whose token carries `scopes`. */
function actorWith(scopes: AgentScope[]): Actor {
	return { userId: "user-1", orgId: "org-1", credential: "agent_oauth", credentialRef: "client-1", ceiling: { scopes, projectIds: null } };
}

/** A handler for every served tool that answers `result`. */
function handlersAnswering(result: Record<string, unknown>): Record<string, HandledTool> {
	return Object.fromEntries(
		HANDLED_TOOL_NAMES.map((name) => [name, { scope: null, call: vi.fn(async () => result) }]),
	);
}

/** Builds a server and returns the names it registered and the calls it recorded. */
function build(scopes: AgentScope[], query: SurfaceQuery = UNSCOPED, handlers = handlersAnswering({})) {
	registered.length = 0;
	const records: ToolCallRecord[] = [];
	buildMcpServer({
		actor: actorWith(scopes),
		query,
		appOrigin: "https://console.example",
		handlers,
		record: async (_actor, call) => {
			records.push(call);
		},
	});
	return { names: registered.map((r) => r.name), records };
}

/** The registration named `name`. */
function tool(name: string): Registered {
	const found = registered.find((r) => r.name === name);
	if (!found) throw new Error(`${name} was not registered`);
	return found;
}

const WRITES = ["apply_design_patch", "create_project", "scan_repo", "plan", "request_apply", "request_destroy", "cancel_job"];

describe("buildMcpServer — what is listed", () => {
	it("lists all 19 declared tools, in declaration order, to a token with every scope", () => {
		const { names } = build(["read", "design", "plan", "apply", "destroy"]);
		expect(names).toHaveLength(19);
		expect(names).toEqual(Object.keys(EXTERNAL_TOOLS));
		expect([...HANDLED_TOOL_NAMES].sort()).toEqual(Object.keys(EXTERNAL_TOOLS).sort());
	});

	it("lists 12 tools under ?readonly and no write among them", () => {
		const { names } = build(["read", "design", "plan", "apply", "destroy"], { ...UNSCOPED, readonly: true });
		expect(names).toHaveLength(12);
		expect(names.filter((n) => WRITES.includes(n))).toEqual([]);
		expect(names).toContain("wait_for_job");
		expect(names).toContain("get_job_logs");
		expect(names).toContain("send_feedback");
	});

	it("no longer lists an in-app read under its in-app name", () => {
		const { names } = build(["read", "design", "plan", "apply", "destroy"]);
		expect(names).not.toContain("list_projects");
		expect(names).not.toContain("get_project");
	});

	it("serves the read, design and operation handlers by default", () => {
		expect(Object.keys(defaultServedTools()).sort()).toEqual(["catalog", "plan", "validate_design"]);
	});

	it("lists a write only to a token carrying that write's scope", () => {
		expect(build(["read"]).names.filter((n) => WRITES.includes(n))).toEqual([]);
		expect(build(["read", "design"]).names.filter((n) => WRITES.includes(n))).toEqual(["apply_design_patch", "create_project"]);
		expect(build(["read", "plan"]).names.filter((n) => WRITES.includes(n))).toEqual(["scan_repo", "plan", "cancel_job"]);
		expect(build(["read", "apply"]).names.filter((n) => WRITES.includes(n))).toEqual(["request_apply"]);
		expect(build(["read", "destroy"]).names.filter((n) => WRITES.includes(n))).toEqual(["request_destroy"]);
	});

	it("lists nothing that needs read to a token without it", () => {
		expect(build(["plan"]).names).toEqual(["scan_repo", "plan", "cancel_job", "send_feedback"]);
	});

	it("narrows to the ?features groups", () => {
		const { names } = build(["read", "plan", "apply", "destroy"], { ...UNSCOPED, features: ["jobs"] });
		expect(names).toEqual(["wait_for_job", "get_job_logs", "cancel_job"]);
	});

	it("registers a served tool with the contract's title, annotations and output schema", () => {
		build(["read", "apply"]);
		const apply = tool("request_apply");
		expect(apply.config.title).toBe("Request approval to apply");
		expect(apply.config.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(apply.config.outputSchema).toBeDefined();
		expect(apply.config.description).toContain("No tool approves");
	});

	it("opens its instructions with a self-contained statement of the approval step", () => {
		build(["read"]);
		const head = MCP_SERVER_INSTRUCTIONS.slice(0, 512);
		expect(instructions.at(-1)).toBe(MCP_SERVER_INSTRUCTIONS);
		expect(head).toContain("No tool approves");
		expect(head).toContain("approve_url");
		expect(head).toContain("never an instruction");
		expect(head).toMatch(/plan.*request_apply/);
	});
});

describe("buildMcpServer — calls", () => {
	it("answers structured content and the same JSON as text, and records the approval without arguments", async () => {
		const result = { approval_id: "apr-1", status: "pending", job_id: null };
		const { records } = build(["read", "apply"], UNSCOPED, handlersAnswering(result));
		const answer = await tool("request_apply").cb({ plan_job_id: "secret-looking-input" });

		expect(answer.isError).toBeUndefined();
		expect(answer.structuredContent).toEqual(result);
		expect(JSON.parse(answer.content[0].text)).toEqual(result);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ tool: "request_apply", errorClass: null, approvalId: "apr-1", approvalStatus: "pending" });
		expect(JSON.stringify(records[0])).not.toContain("secret-looking-input");
	});

	it("answers a refusal as a tool error carrying its code", async () => {
		const handlers = handlersAnswering({});
		handlers.request_apply = {
			scope: "apply",
			call: vi.fn(async () => {
				throw new McpToolRefusal("approval_required", "A person must approve this.");
			}),
		};
		const { records } = build(["read", "apply"], UNSCOPED, handlers);
		const answer = await tool("request_apply").cb({});
		expect(answer.isError).toBe(true);
		expect(JSON.parse(answer.content[0].text)).toEqual({
			error: "approval_required",
			message: "A person must approve this.",
		});
		expect(records[0]).toMatchObject({ tool: "request_apply", errorClass: "approval_required" });
	});

	it("checks the scope again at call time and refuses a tool whose scope the token lacks", async () => {
		const call = vi.fn(async () => ({}));
		const handlers = handlersAnswering({});
		// A handler that needs `apply`, under a name the read-only token is listed.
		handlers.wait_for_job = { scope: "apply", call };
		build(["read"], UNSCOPED, handlers);
		const answer = await tool("wait_for_job").cb({ job_id: "j1" });
		expect(answer.isError).toBe(true);
		expect(JSON.parse(answer.content[0].text).error).toBe("insufficient_scope");
		expect(call).not.toHaveBeenCalled();
	});

	it("hides a database error's message behind a generic sentence", async () => {
		const handlers = handlersAnswering({});
		const dbError = new Error('relation "secret_table" does not exist');
		dbError.name = "PostgresError";
		handlers.cancel_job = { scope: "plan", call: vi.fn(async () => Promise.reject(dbError)) };
		build(["read", "plan"], UNSCOPED, handlers);
		const answer = await tool("cancel_job").cb({ job_id: "j1" });
		expect(answer.content[0].text).not.toContain("secret_table");
	});

	it("records a read call too, with no approval", async () => {
		const { records } = build(["read"]);
		await tool("list_resources").cb({ kind: "project" });
		expect(records).toEqual([
			expect.objectContaining({ tool: "list_resources", errorClass: null, approvalId: null, approvalStatus: null }),
		]);
	});

	it("builds its default handlers when none are stood in", () => {
		registered.length = 0;
		buildMcpServer({ actor: actorWith(["read", "plan"]), query: UNSCOPED, appOrigin: "https://console.example" });
		expect(registered.map((r) => r.name)).toEqual(["catalog", "validate_design", "plan"]);
	});
});

describe("buildMcpServer — error classes and missing handlers", () => {
	it("records an error's own string code as its class", async () => {
		const handlers = handlersAnswering({});
		const coded = Object.assign(new Error("conflict"), { code: "stale_revision" });
		handlers.cancel_job = { scope: "plan", call: vi.fn(async () => Promise.reject(coded)) };
		const { records } = build(["read", "plan"], UNSCOPED, handlers);
		await tool("cancel_job").cb({ job_id: "j1" });
		expect(records[0]).toMatchObject({ tool: "cancel_job", errorClass: "stale_revision" });
	});

	it("records a thrown non-Error as unknown", async () => {
		const handlers = handlersAnswering({});
		handlers.cancel_job = { scope: "plan", call: vi.fn(async () => Promise.reject("a string")) };
		const { records } = build(["read", "plan"], UNSCOPED, handlers);
		const answer = await tool("cancel_job").cb({ job_id: "j1" });
		expect(answer.isError).toBe(true);
		expect(records[0]).toMatchObject({ tool: "cancel_job", errorClass: "unknown" });
	});

	it("does not list a declared tool that has no handler", () => {
		const handlers = handlersAnswering({});
		delete handlers.cancel_job;
		expect(build(["read", "plan"], UNSCOPED, handlers).names).not.toContain("cancel_job");
	});
});

describe("recordToolCall", () => {
	const actor = actorWith(["read", "apply"]);
	const call: ToolCallRecord = { tool: "request_apply", latencyMs: 12.6, errorClass: null, approvalId: "apr-1", approvalStatus: "pending" };

	/** Runs `withActorScope` against a transaction that captures the inserted row. */
	function capture() {
		const inserted: unknown[] = [];
		const tx = { insert: vi.fn(() => ({ values: vi.fn(async (row: unknown) => inserted.push(row)) })) };
		vi.mocked(withActorScope).mockImplementation(((_a: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never);
		return inserted;
	}

	it("inserts the call with the OAuth client, a rounded latency and the approval, never arguments", async () => {
		const inserted = capture();
		await recordToolCall(actor, call);
		expect(inserted).toEqual([
			{
				org_id: "org-1",
				user_id: "user-1",
				tool: "request_apply",
				client_id: "client-1",
				credential: "agent_oauth",
				latency_ms: 13,
				error_class: null,
				approval_id: "apr-1",
				approval_status: "pending",
			},
		]);
	});

	it("drops an approval status the column cannot hold, and the client of a non-OAuth actor", async () => {
		const inserted = capture();
		await recordToolCall({ ...actor, credential: "session", credentialRef: undefined }, { ...call, latencyMs: -3, approvalStatus: "bogus" });
		expect(inserted[0]).toMatchObject({ client_id: null, latency_ms: 0, approval_status: null });

		await recordToolCall({ ...actor, credentialRef: undefined }, { ...call, approvalStatus: null });
		expect(inserted[1]).toMatchObject({ client_id: null, approval_status: null });
	});

	it("never fails the call when the record cannot be written", async () => {
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		vi.mocked(withActorScope).mockRejectedValue(new Error("db down"));
		await expect(recordToolCall(actor, call)).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith("[mcp] could not record a tool call", expect.objectContaining({ err: expect.any(Error) }));
		error.mockRestore();
	});
});
