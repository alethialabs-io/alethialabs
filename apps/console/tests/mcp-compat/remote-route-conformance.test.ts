// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Conformance of the remote MCP endpoint (app/api/mcp/route.ts) at the wire, revision by revision
// (AGT-L6, #6863; spec §4.8).
//
// WHAT IS REAL HERE. The route module, the MCP SDK's `createMcpHandler` with the posture the route
// passes it, and `buildMcpServer` with the declared tool contract (lib/ai/mcp/surface.ts) — so the
// tool list, the instructions, the input and output schemas and the era rejection are the ones a
// client meets. Each request is a raw JSON-RPC POST, written the way the revision's own wire format
// says, not through an SDK client: a client is not an SDK, and the SDK's own client would agree with
// its server by construction.
//
// WHAT IS STOOD IN. OAuth (`requireMcpAuth` hands the route fixed claims), the actor resolution, the
// plan check and the tool handlers. Those have their own tests (tests/app/api/mcp-route-audience.test.ts,
// tests/lib/ai/mcp/*). A green run here therefore says "a client speaking revision X gets these
// answers from this route"; it says NOTHING about OAuth discovery, CIMD, or any named client.
//
// The last block is the dual-era readiness check the spec's decision rule needs: the same server
// factory under the SDK's `legacy: "stateless"` posture serves the 2025-era sequence. It does not
// test the route (which rejects that era); it proves the one-option fallback would serve.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const MCP_URL = "https://alethialabs.io/api/mcp";

vi.mock("@better-auth/mcp", () => ({
	mcp: vi.fn(() => ({ id: "mcp" })),
	// The route hands this its token handler; the stand-in calls it with verified-looking claims.
	requireMcpAuth:
		(_auth: unknown, handler: (req: Request, claims: Record<string, unknown>) => Promise<Response>) =>
		(req: Request) =>
			handler(req, { sub: "user-1", azp: "client-1", scope: "read design plan apply destroy" }),
}));
vi.mock("@/lib/auth", () => ({ auth: {}, mcpResourceUrl: "https://alethialabs.io/api/mcp" }));
vi.mock("@/lib/ai/mcp/actor", () => ({ resolveMcpActor: vi.fn() }));
vi.mock("@/lib/billing/ai-guard", () => ({ isAiSurfaceEnabled: vi.fn(async () => true) }));

// The server is the real one; only its handlers and its call record are stood in.
vi.mock("@/lib/ai/mcp/server", async () => {
	const actual = await vi.importActual<typeof import("@/lib/ai/mcp/server")>("@/lib/ai/mcp/server");
	const { standInHandlers } = await import("./stand-in-handlers");
	return {
		...actual,
		buildMcpServer: (ctx: Parameters<typeof actual.buildMcpServer>[0]) =>
			actual.buildMcpServer({ ...ctx, handlers: standInHandlers(), record: async () => {} }),
	};
});

// What the real server module imports and nothing here reaches.
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
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
	destroyPlanFor: vi.fn(),
}));
vi.mock("@/lib/ai/mcp/job-logs", () => ({ readJobLogPage: vi.fn() }));

import { createMcpHandler, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { resolveMcpActor } from "@/lib/ai/mcp/actor";
import { buildMcpServer, MCP_SERVER_INSTRUCTIONS } from "@/lib/ai/mcp/server";
import { EXTERNAL_TOOLS } from "@/lib/ai/mcp/surface";
import type { Actor } from "@/lib/authz/types";
import { STAND_IN_ANSWERS } from "./stand-in-handlers";

/** The one modern revision, the revision of the per-request `_meta` envelope. */
const MODERN = "2026-07-28";

/**
 * Every 2025-era revision a client might open with, written out rather than read from the SDK: the
 * matrix is a statement of what was tested, and a list derived from the SDK would move under it.
 * The SDK's list is checked against this one below, so a revision the SDK learns is noticed here.
 */
const LEGACY_REVISIONS = ["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/** A token holding every agent scope; the route resolves to it unless a test says otherwise. */
const FULL_ACTOR: Actor = {
	userId: "user-1",
	orgId: "org-1",
	credential: "agent_oauth",
	credentialRef: "client-1",
	ceiling: { scopes: ["read", "design", "plan", "apply", "destroy"], projectIds: null },
};

const rpcError = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
const rpcResponse = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number(), z.null()]),
	result: z.record(z.string(), z.unknown()).optional(),
	error: rpcError.optional(),
});
const listedTool = z.object({ name: z.string(), inputSchema: z.object({ type: z.literal("object") }).loose() }).loose();
const toolsListResult = z.object({ tools: z.array(listedTool) }).loose();
const callResult = z
	.object({ isError: z.boolean().optional(), structuredContent: z.record(z.string(), z.unknown()).optional() })
	.loose();
const discoverResult = z
	.object({ supportedVersions: z.array(z.string()), capabilities: z.object({ tools: z.object({}).loose() }).loose(), instructions: z.string() })
	.loose();

/** The 2026-07-28 per-request envelope a modern client puts in every request's `_meta`. */
function envelope(version: string): Record<string, unknown> {
	return {
		"io.modelcontextprotocol/protocolVersion": version,
		"io.modelcontextprotocol/clientInfo": { name: "alethia-conformance", version: "0" },
		"io.modelcontextprotocol/clientCapabilities": {},
	};
}

/** Answers one POST through the route's exported handler, as Next would call it. */
async function postToRoute(body: unknown, headers: Record<string, string>, url = MCP_URL): Promise<Response> {
	const { POST } = await import("@/app/api/mcp/route");
	return POST(
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
			body: JSON.stringify(body),
		}),
	);
}

/** A modern request: the envelope in `_meta`, and the standard headers that must agree with it. */
function modernRequest(id: number, method: string, params: Record<string, unknown> = {}, version = MODERN) {
	const headers: Record<string, string> = { "mcp-protocol-version": version, "mcp-method": method };
	const name = params.name;
	if (method === "tools/call" && typeof name === "string") headers["mcp-name"] = name;
	return { body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope(version) } }, headers };
}

/** The JSON-RPC response a 2026-07-28 exchange answered with. */
async function modernExchange(id: number, method: string, params: Record<string, unknown> = {}, url = MCP_URL) {
	const { body, headers } = modernRequest(id, method, params);
	const res = await postToRoute(body, headers, url);
	return { status: res.status, rpc: rpcResponse.parse(await res.json()) };
}

/** A 2025-era `initialize`, as a client opening with `version` sends it. */
function legacyInitialize(version: string) {
	return {
		body: {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "alethia-conformance", version: "0" } },
		},
		headers: { "mcp-protocol-version": version },
	};
}

/** Points the route's actor resolution at `actor`. */
function resolveTo(actor: Actor): void {
	vi.mocked(resolveMcpActor).mockResolvedValue({ ok: true, actor });
}

describe("the tested revision list", () => {
	it("covers every 2025-era revision the SDK knows, so a new one is noticed", () => {
		for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
			expect(LEGACY_REVISIONS).toContain(version);
		}
	});
});

describe("remote route — 2025-era revisions are refused with the revision that is served", () => {
	it.each(LEGACY_REVISIONS)("initialize at %s is answered 400, -32022, naming 2026-07-28 as the only revision served", async (version) => {
		resolveTo(FULL_ACTOR);
		const { body, headers } = legacyInitialize(version);
		const res = await postToRoute(body, headers);
		expect(res.status).toBe(400);
		const rpc = rpcResponse.parse(await res.json());
		expect(rpc.id).toBe(1);
		expect(rpc.error?.code).toBe(-32022);
		expect(rpc.error?.data).toEqual({ supported: [MODERN], requested: version });
	});

	it("a 2025-era tools/list with no envelope is refused the same way, so skipping initialize does not get in", async () => {
		resolveTo(FULL_ACTOR);
		const res = await postToRoute({ jsonrpc: "2.0", id: 7, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
		expect(res.status).toBe(400);
		expect(rpcResponse.parse(await res.json()).error?.code).toBe(-32022);
	});

	it("a 2025-era notification is acknowledged 202 and dropped", async () => {
		resolveTo(FULL_ACTOR);
		const res = await postToRoute({ jsonrpc: "2.0", method: "notifications/initialized" }, {});
		expect(res.status).toBe(202);
	});

	it("exports POST only: there is no GET (SSE) or DELETE (session) handler for a 2025 client to reach", async () => {
		const route = await import("@/app/api/mcp/route");
		expect(Object.keys(route).filter((key) => ["GET", "DELETE", "PUT", "PATCH"].includes(key))).toEqual([]);
		expect(typeof route.POST).toBe("function");
	});
});

describe("remote route — 2026-07-28, the sequence spec §4.8 names", () => {
	it("server/discover advertises exactly 2026-07-28, the tools capability and the instructions", async () => {
		resolveTo(FULL_ACTOR);
		const { status, rpc } = await modernExchange(1, "server/discover");
		expect(status).toBe(200);
		const result = discoverResult.parse(rpc.result);
		expect(result.supportedVersions).toEqual([MODERN]);
		expect(result.instructions).toBe(MCP_SERVER_INSTRUCTIONS);
	});

	it("tools/list lists the 19 declared tools, each with an object input schema", async () => {
		resolveTo(FULL_ACTOR);
		const { status, rpc } = await modernExchange(2, "tools/list");
		expect(status).toBe(200);
		const names = toolsListResult.parse(rpc.result).tools.map((tool) => tool.name);
		expect(names).toEqual(Object.keys(EXTERNAL_TOOLS));
		expect(names).toHaveLength(19);
	});

	it("tools/list under ?readonly lists the 12 tools that survive it", async () => {
		resolveTo(FULL_ACTOR);
		const { rpc } = await modernExchange(3, "tools/list", {}, `${MCP_URL}?readonly`);
		const names = toolsListResult.parse(rpc.result).tools.map((tool) => tool.name);
		expect(names).toHaveLength(12);
		expect(names).not.toContain("request_apply");
	});

	it("a read call returns its result as structuredContent", async () => {
		resolveTo(FULL_ACTOR);
		const { rpc } = await modernExchange(4, "tools/call", { name: "validate_design", arguments: { design: {} } });
		const result = callResult.parse(rpc.result);
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toEqual(STAND_IN_ANSWERS.validate_design);
	});

	it("request_apply returns the pending approval, and wait_for_job reports it decided", async () => {
		resolveTo(FULL_ACTOR);
		const request = await modernExchange(5, "tools/call", { name: "request_apply", arguments: { plan_job_id: "plan-1" } });
		const pending = callResult.parse(request.rpc.result);
		expect(pending.structuredContent).toEqual(STAND_IN_ANSWERS.request_apply);

		const wait = await modernExchange(6, "tools/call", { name: "wait_for_job", arguments: { approval_id: "appr-1" } });
		expect(callResult.parse(wait.rpc.result).structuredContent).toEqual(STAND_IN_ANSWERS.wait_for_job);
	});

	it("a call whose arguments break the tool's input schema is refused, not run", async () => {
		resolveTo(FULL_ACTOR);
		const { rpc } = await modernExchange(7, "tools/call", { name: "request_apply", arguments: {} });
		// The SDK answers a schema failure as a tool error the model can read and correct.
		const refused = rpc.error !== undefined || callResult.parse(rpc.result).isError === true;
		expect(refused).toBe(true);
	});

	it("a token without the apply scope is not listed request_apply", async () => {
		resolveTo({ ...FULL_ACTOR, ceiling: { scopes: ["read"], projectIds: null } });
		const { rpc } = await modernExchange(8, "tools/list");
		const names = toolsListResult.parse(rpc.result).tools.map((tool) => tool.name);
		expect(names).not.toContain("request_apply");
		expect(names).toContain("wait_for_job");
	});

	it("an envelope naming a revision this server does not serve is refused -32022", async () => {
		resolveTo(FULL_ACTOR);
		const { body, headers } = modernRequest(9, "tools/list", {}, "2099-01-01");
		const res = await postToRoute(body, headers);
		expect(res.status).toBe(400);
		const rpc = rpcResponse.parse(await res.json());
		expect(rpc.error?.code).toBe(-32022);
		expect(rpc.error?.data).toEqual({ supported: [MODERN], requested: "2099-01-01" });
	});

	it("an envelope whose MCP-Protocol-Version header is missing is refused, not served", async () => {
		resolveTo(FULL_ACTOR);
		const { body } = modernRequest(10, "tools/list");
		const res = await postToRoute(body, { "mcp-method": "tools/list" });
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(rpcResponse.parse(await res.json()).error).toBeDefined();
	});
});

describe("dual-era readiness — the same server under legacy: \"stateless\" (NOT the route's posture)", () => {
	/** One 2025-era POST answered by a stateless-fallback handler over the real server. */
	async function legacyPost(version: string, body: Record<string, unknown>) {
		const handler = createMcpHandler(
			() => buildMcpServer({ actor: FULL_ACTOR, query: { readonly: false, projectId: null, features: null }, appOrigin: "https://alethialabs.io" }),
			{ legacy: "stateless" },
		);
		const res = await handler.fetch(
			new Request(MCP_URL, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version },
				body: JSON.stringify(body),
			}),
		);
		return { status: res.status, rpc: rpcResponse.parse(parseSseOrJson(await res.text())) };
	}

	it.each(["2025-03-26", "2025-06-18", "2025-11-25"])("serves initialize, tools/list and a read call at %s", async (version) => {
		const init = await legacyPost(version, legacyInitialize(version).body);
		expect(init.status).toBe(200);
		expect(init.rpc.result?.protocolVersion).toBe(version);

		const list = await legacyPost(version, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(toolsListResult.parse(list.rpc.result).tools).toHaveLength(19);

		const call = await legacyPost(version, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "validate_design", arguments: { design: {} } },
		});
		expect(callResult.parse(call.rpc.result).structuredContent).toEqual(STAND_IN_ANSWERS.validate_design);
	});
});

/** A response body that is either one JSON value or an SSE stream whose first `data:` line is one. */
function parseSseOrJson(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return JSON.parse(trimmed);
	const dataLine = trimmed.split("\n").find((line) => line.startsWith("data:"));
	if (dataLine === undefined) throw new Error(`no JSON-RPC message in: ${trimmed.slice(0, 200)}`);
	return JSON.parse(dataLine.slice("data:".length));
}
