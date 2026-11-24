// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The audience the MCP route verifies against (#3511).
//
// This exists because deleting the `{ resource }` argument at app/api/mcp/route.ts left 3917
// tests, `check-types`, `lint` and every repo guard green while remote MCP auth was completely
// dead: tests/setup.ts stubs `requireMcpAuth` with TWO parameters, discarding the third, and
// nothing under tests/ imported the route at all. A fix whose absence is invisible is a fix that
// gets refactored away.
//
// The file-level mock below takes precedence over the one in tests/setup.ts (the documented
// pattern — see tests/lib/auth/index.test.ts), and it captures every argument.

import { describe, expect, it, vi } from "vitest";

const requireMcpAuth = vi.fn((_auth: unknown, handler: unknown, _opts?: unknown) => handler);

vi.mock("@better-auth/mcp", () => ({
	mcp: vi.fn(() => ({ id: "mcp" })),
	requireMcpAuth: (auth: unknown, handler: unknown, opts?: unknown) =>
		requireMcpAuth(auth, handler, opts),
}));

// `mcpResourceUrl` is the ONE constant mcp() and requireMcpAuth must agree on. The value here
// stands in for what lib/auth computes from the deployment's base URL.
const MCP_RESOURCE = "https://alethialabs.io/api/mcp";
vi.mock("@/lib/auth", () => ({
	auth: { handler: vi.fn() },
	mcpResourceUrl: MCP_RESOURCE,
}));

// The route's remaining boundaries: none of them are the subject here.
vi.mock("@modelcontextprotocol/server", () => ({
	createMcpHandler: vi.fn(() => ({ fetch: vi.fn() })),
	McpServer: class {},
}));
vi.mock("@/lib/ai/mcp/server", () => ({ buildMcpServer: vi.fn() }));
vi.mock("@/lib/ai/mcp/actor", () => ({ resolveMcpActor: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ runWithActor: vi.fn() }));
vi.mock("@/lib/billing/ai-guard", () => ({ isAiSurfaceEnabled: vi.fn(async () => true) }));

describe("the MCP route's token audience", () => {
	it("verifies against the resource mcp() binds tokens to, not the auth base URL", async () => {
		await import("@/app/api/mcp/route");

		expect(requireMcpAuth).toHaveBeenCalledTimes(1);
		const opts = requireMcpAuth.mock.calls[0][2];
		// The whole defect in one assertion: left to default, `resource` is the auth BASE URL, and
		// requireMcpAuth feeds it in as `audience` — so a token mcp() minted for /api/mcp fails
		// verification and MCP can never authenticate.
		expect(opts).toEqual({ resource: MCP_RESOURCE });
		expect(MCP_RESOURCE.endsWith("/api/mcp")).toBe(true);
		expect(JSON.stringify(opts)).not.toContain("/api/auth");
	});
});

/** Calls the handler the route handed `requireMcpAuth` on its first import, and answers its response. */
async function callTokenHandler(req: Request, claims: Record<string, unknown>): Promise<Response | undefined> {
	const handler = requireMcpAuth.mock.calls[0][1];
	if (typeof handler !== "function") throw new Error("the route handed requireMcpAuth no handler");
	const res: unknown = await handler(req, claims);
	return res instanceof Response ? res : undefined;
}

// Runs between the two blocks around it on purpose: it reads the handler the first block's import
// handed to `requireMcpAuth`, and the block below clears that call.
describe("the actor an MCP access token is resolved into", () => {
	it("is the one resolveMcpActor answers, bound for the whole request", async () => {
		await import("@/app/api/mcp/route");
		const { resolveMcpActor } = await import("@/lib/ai/mcp/actor");
		const { runWithActor } = await import("@/lib/authz/actor-context");
		const actor = {
			userId: "user-1",
			orgId: "org-1",
			credential: "agent_oauth" as const,
			ceiling: { scopes: ["read" as const], projectIds: null },
		};
		vi.mocked(resolveMcpActor).mockResolvedValue({ ok: true, actor });

		const claims = { sub: "user-1", scope: "read" };
		await callTokenHandler(new Request("https://alethialabs.io/api/mcp?project=p1", { method: "POST" }), claims);

		expect(resolveMcpActor).toHaveBeenCalledWith(claims, "p1");
		expect(runWithActor).toHaveBeenCalledTimes(1);
		expect(runWithActor).toHaveBeenCalledWith(actor, expect.any(Function));
	});

	it("answers a token with no agent scope 403 with a step-up challenge, and binds no actor", async () => {
		await import("@/app/api/mcp/route");
		const { resolveMcpActor } = await import("@/lib/ai/mcp/actor");
		const { runWithActor } = await import("@/lib/authz/actor-context");
		vi.mocked(runWithActor).mockClear();
		vi.mocked(resolveMcpActor).mockResolvedValue({ ok: false, reason: "insufficient_scope" });

		const res = await callTokenHandler(new Request("https://alethialabs.io/api/mcp", { method: "POST" }), {
			sub: "user-1",
		});
		expect(res?.status).toBe(403);
		expect(res?.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
		expect(runWithActor).not.toHaveBeenCalled();
	});

	it("answers 403 while the organization's agent access is off", async () => {
		await import("@/app/api/mcp/route");
		const { resolveMcpActor } = await import("@/lib/ai/mcp/actor");
		vi.mocked(resolveMcpActor).mockResolvedValue({ ok: false, reason: "agent_access_disabled" });
		const res = await callTokenHandler(new Request("https://alethialabs.io/api/mcp", { method: "POST" }), {
			sub: "user-1",
			scope: "read",
		});
		expect(res?.status).toBe(403);
		expect(await res?.json()).toEqual({ error: expect.stringContaining("Agent access is turned off") });
	});

	it("refuses a mistyped URL scoping rather than listing everything", async () => {
		await import("@/app/api/mcp/route");
		const res = await callTokenHandler(
			new Request("https://alethialabs.io/api/mcp?features=nope", { method: "POST" }),
			{ sub: "user-1", scope: "read" },
		);
		expect(res?.status).toBe(400);
	});
});

describe("a deployment that cannot form an MCP resource", () => {
	it("answers 503 rather than a 401 pointing at a document it 404s", async () => {
		vi.resetModules();
		requireMcpAuth.mockClear();
		vi.doMock("@/lib/auth", () => ({ auth: { handler: vi.fn() }, mcpResourceUrl: null }));

		const route = await import("@/app/api/mcp/route");
		const res = await route.POST(
			new Request("https://alethialabs.io/api/mcp", { method: "POST" }),
		);

		expect(res.status).toBe(503);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = await res.json();
		expect(body.error.message).toContain("not configured");
		// The library's default would have answered 401 with
		// `resource_metadata=…/oauth-protected-resource/api/auth`, which this deployment 404s.
		expect(requireMcpAuth).not.toHaveBeenCalled();

		vi.doUnmock("@/lib/auth");
		vi.resetModules();
	});
});
