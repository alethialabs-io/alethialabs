// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The MCP route bound to the consent grant (AGT-L2-F), through the REAL actor resolution with only
// the reads stood in: the grant read, the person's org membership and the agent switch. What the
// route answers, and the actor it binds, when the grant names another org, other projects, or was
// revoked between two requests carrying the same (still verifiable) token.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrantBinding } from "@/lib/agents/grant-binding";

const requireMcpAuth = vi.fn((_auth: unknown, handler: unknown, _opts?: unknown) => handler);
vi.mock("@better-auth/mcp", () => ({
	mcp: vi.fn(() => ({ id: "mcp" })),
	requireMcpAuth: (auth: unknown, handler: unknown, opts?: unknown) => requireMcpAuth(auth, handler, opts),
}));
vi.mock("@/lib/auth", () => ({ auth: { handler: vi.fn() }, mcpResourceUrl: "https://alethialabs.io/api/mcp" }));
vi.mock("@modelcontextprotocol/server", () => ({
	createMcpHandler: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
	McpServer: class {},
}));
vi.mock("@/lib/ai/mcp/server", () => ({ buildMcpServer: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({
	runWithActor: vi.fn((_actor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/billing/ai-guard", () => ({ isAiSurfaceEnabled: vi.fn(async () => true) }));

// The reads behind the real resolveMcpActor.
vi.mock("@/lib/agents/grant-binding", () => ({ readGrantBinding: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/approvals/context", () => ({ readAgentPolicy: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));

import { readGrantBinding } from "@/lib/agents/grant-binding";
import { readAgentPolicy } from "@/lib/approvals/context";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { withScope } from "@/lib/db";

/** The person is an active member of these orgs only; anything else falls back to the first. */
const MEMBER_OF = ["org-home", "org-granted"];
const CLAIMS = { sub: "user-1", scope: "openid read plan", azp: "client-1" };

/** Answers `binding` for the grant read. */
function grantReads(binding: GrantBinding): void {
	vi.mocked(readGrantBinding).mockResolvedValue(binding);
}

/** Posts to the route as `claims` (the verified token), with `query` on the URL. */
async function post(query = "", claims: Record<string, unknown> = CLAIMS): Promise<Response> {
	await import("@/app/api/mcp/route");
	const handler = requireMcpAuth.mock.calls[0]?.[1];
	if (typeof handler !== "function") throw new Error("the route handed requireMcpAuth no handler");
	const res: unknown = await handler(new Request(`https://alethialabs.io/api/mcp${query}`, { method: "POST" }), claims);
	if (!(res instanceof Response)) throw new Error("the route answered no Response");
	return res;
}

/** The actor the last request was bound to, or undefined when none was bound. */
function boundActor(): unknown {
	return vi.mocked(runWithActor).mock.calls.at(-1)?.[0];
}

beforeEach(() => {
	vi.mocked(runWithActor).mockClear();
	vi.mocked(readGrantBinding).mockReset();
	vi.mocked(getActiveScope).mockReset();
	vi.mocked(getActiveScope).mockImplementation(async (userId: string, orgId?: string) => ({
		userId,
		orgId: orgId && MEMBER_OF.includes(orgId) ? orgId : MEMBER_OF[0],
	}));
	vi.mocked(withScope).mockImplementation(((_s: unknown, cb: (tx: unknown) => unknown) => cb({})) as never);
	vi.mocked(readAgentPolicy).mockResolvedValue({ agentAccessEnabled: true } as never);
});

describe("an MCP request under a live consent grant", () => {
	it("acts in the grant's organization, held to its projects, never the person's default org", async () => {
		grantReads({ kind: "live", grant: { orgId: "org-granted", scopes: ["read"], projectIds: ["p1", "p2"] } });
		const res = await post();
		expect(res.status).toBe(200);
		expect(readGrantBinding).toHaveBeenCalledWith("user-1", "client-1");
		expect(boundActor()).toMatchObject({
			userId: "user-1",
			orgId: "org-granted",
			credential: "agent_oauth",
			credentialRef: "client-1",
			ceiling: { scopes: ["read"], projectIds: ["p1", "p2"] },
		});
	});

	it("refuses a grant in an organization the person is no longer an active member of", async () => {
		grantReads({ kind: "live", grant: { orgId: "org-other", scopes: ["read"], projectIds: null } });
		const res = await post();
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: expect.stringContaining("not one you are an active member of") });
		expect(runWithActor).not.toHaveBeenCalled();
	});

	it("refuses a project outside the grant, by URL pin", async () => {
		grantReads({ kind: "live", grant: { orgId: "org-granted", scopes: ["read"], projectIds: ["p1"] } });
		const res = await post("?project=p9");
		expect(res.status).toBe(403);
		expect(runWithActor).not.toHaveBeenCalled();
	});

	it("refuses a grant that records no organization", async () => {
		grantReads({ kind: "live", grant: { orgId: "", scopes: ["read"], projectIds: null } });
		const res = await post();
		expect(res.status).toBe(403);
		expect(getActiveScope).not.toHaveBeenCalled();
		expect(runWithActor).not.toHaveBeenCalled();
	});
});

describe("an MCP request after its consent grant was revoked", () => {
	it("answers the very next request 401 with an invalid_token challenge, the same token notwithstanding", async () => {
		grantReads({ kind: "live", grant: { orgId: "org-granted", scopes: ["read"], projectIds: ["p1"] } });
		expect((await post()).status).toBe(200);

		vi.mocked(runWithActor).mockClear();
		grantReads({ kind: "revoked" });
		const res = await post();
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe(
			'Bearer error="invalid_token", resource_metadata="https://alethialabs.io/.well-known/oauth-protected-resource/api/mcp"',
		);
		expect(await res.json()).toEqual({ error: expect.stringContaining("disconnected") });
		expect(runWithActor).not.toHaveBeenCalled();
		// Not answered from the no-grant path: no org was resolved for the revoked request.
		expect(getActiveScope).toHaveBeenCalledTimes(1);
	});
});

describe("an MCP token with no grant row", () => {
	it("keeps the token's own scopes over every project in the person's org", async () => {
		grantReads({ kind: "none" });
		expect((await post()).status).toBe(200);
		expect(boundActor()).toMatchObject({ orgId: "org-home", ceiling: { scopes: ["read", "plan"], projectIds: null } });
	});

	it("refuses a token that names no client, without reading any grant", async () => {
		const res = await post("", { sub: "user-1", scope: "read" });
		expect(res.status).toBe(401);
		expect(readGrantBinding).not.toHaveBeenCalled();
		expect(runWithActor).not.toHaveBeenCalled();
	});
});
