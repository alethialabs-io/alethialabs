// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The MCP server one request is answered by (lib/ai/mcp/server.ts), with the SDK's McpServer stood
// in by a recorder: what it lists for a token's scopes and the URL's scoping, how a call's result and
// refusal come back, that each call is recorded without its arguments, and that the scope is checked
// again when a tool is called.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
vi.mock("@/lib/ai/tools", () => ({
	buildExternalAgentTools: () => ({
		list_projects: { description: "in-app list", inputSchema: z.object({}), execute: vi.fn(async () => []) },
		get_plan_result: { description: "in-app plan result", inputSchema: z.object({}), execute: vi.fn(async () => ({})) },
	}),
}));
vi.mock("@/lib/ai/mcp/handlers", async () => {
	const actual = await vi.importActual<typeof import("@/lib/ai/mcp/handlers")>("@/lib/ai/mcp/handlers");
	return { ...actual, createHandlers: () => ({}) };
});
vi.mock("@/app/server/actions/projects", () => ({ planProject: vi.fn(), provisionProject: vi.fn(), destroyProject: vi.fn() }));
vi.mock("@/app/server/actions/jobs", () => ({ cancelJob: vi.fn() }));
vi.mock("@/lib/rpc/procedures/jobs", () => ({ readJobStatus: vi.fn() }));
vi.mock("@/lib/ai/mcp/approval-store", () => ({
	findOwnApproval: vi.fn(),
	requestOwnApproval: vi.fn(),
	readOwnOrgApproval: vi.fn(),
	appliedPlanFor: vi.fn(),
}));
vi.mock("@/lib/ai/mcp/job-logs", () => ({ readJobLogPage: vi.fn() }));

import { type HandledTool, HANDLED_TOOL_NAMES, McpToolRefusal } from "@/lib/ai/mcp/handlers";
import { buildMcpServer, MCP_SERVER_INSTRUCTIONS, type ToolCallRecord } from "@/lib/ai/mcp/server";
import type { AgentScope, SurfaceQuery } from "@/lib/ai/mcp/surface";
import type { Actor } from "@/lib/authz/types";

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

const WRITES = ["plan", "request_apply", "request_destroy", "cancel_job"];

describe("buildMcpServer — what is listed", () => {
	it("lists the in-app reads and every served tool to a token with every scope", () => {
		const { names } = build(["read", "design", "plan", "apply", "destroy"]);
		expect(names).toEqual(["list_projects", "get_plan_result", ...HANDLED_TOOL_NAMES]);
	});

	it("lists no write under ?readonly", () => {
		const { names } = build(["read", "plan", "apply", "destroy"], { ...UNSCOPED, readonly: true });
		expect(names.filter((n) => WRITES.includes(n))).toEqual([]);
		expect(names).toContain("wait_for_job");
		expect(names).toContain("get_job_logs");
	});

	it("lists a write only to a token carrying that write's scope", () => {
		expect(build(["read"]).names.filter((n) => WRITES.includes(n))).toEqual([]);
		expect(build(["read", "plan"]).names.filter((n) => WRITES.includes(n))).toEqual(["plan", "cancel_job"]);
		expect(build(["read", "apply"]).names.filter((n) => WRITES.includes(n))).toEqual(["request_apply"]);
		expect(build(["read", "destroy"]).names.filter((n) => WRITES.includes(n))).toEqual(["request_destroy"]);
	});

	it("lists nothing that needs read to a token without it", () => {
		expect(build(["plan"]).names).toEqual(["plan", "cancel_job"]);
	});

	it("narrows to the ?features groups, in-app reads included", () => {
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

	it("records an in-app read call too", async () => {
		const { records } = build(["read"]);
		await tool("list_projects").cb({});
		expect(records).toEqual([
			expect.objectContaining({ tool: "list_projects", errorClass: null, approvalId: null }),
		]);
	});
});
