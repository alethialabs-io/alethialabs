// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The actor an MCP access token becomes (lib/ai/mcp/actor.ts), over stood-in reads: the ceiling it is
// held to, the organization the consent grant names, the URL's project pin, and the kill switch.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));

import { type AgentGrant, type McpActorDeps, clientIdFromClaims, resolveMcpActor } from "@/lib/ai/mcp/actor";

/** Reads that answer a person in org-1 with no grant and agent access on, unless overridden. */
function deps(over: Partial<McpActorDeps> = {}): McpActorDeps {
	return {
		readGrant: vi.fn(async () => null),
		resolveScope: vi.fn(async (userId: string, orgId?: string) => ({ userId, orgId: orgId ?? "org-1" })),
		agentAccessEnabled: vi.fn(async () => true),
		...over,
	};
}

const CLAIMS = { sub: "user-1", scope: "openid read plan apply", azp: "client-1" };

describe("resolveMcpActor", () => {
	it("binds the person as agent_oauth, held to the token's scopes, with the client as its reference", async () => {
		const result = await resolveMcpActor(CLAIMS, null, deps());
		expect(result).toEqual({
			ok: true,
			actor: {
				userId: "user-1",
				orgId: "org-1",
				credential: "agent_oauth",
				credentialRef: "client-1",
				ceiling: { scopes: ["read", "plan", "apply"], projectIds: null },
			},
		});
	});

	it("refuses a token with no subject", async () => {
		expect(await resolveMcpActor({ scope: "read" }, null, deps())).toEqual({ ok: false, reason: "no_subject" });
	});

	it("refuses a token that carries no agent scope, rather than treating it as unlimited", async () => {
		expect(await resolveMcpActor({ sub: "user-1", scope: "openid email" }, null, deps())).toEqual({
			ok: false,
			reason: "insufficient_scope",
		});
		expect(await resolveMcpActor({ sub: "user-1" }, null, deps())).toEqual({
			ok: false,
			reason: "insufficient_scope",
		});
	});

	it("acts in the grant's organization, narrowed to the grant's scopes and projects", async () => {
		const grant: AgentGrant = { orgId: "org-2", scopes: ["read", "plan"], projectIds: ["p1", "p2"] };
		const d = deps({ readGrant: vi.fn(async () => grant) });
		const result = await resolveMcpActor(CLAIMS, null, d);
		expect(d.readGrant).toHaveBeenCalledWith("user-1", "client-1");
		expect(d.resolveScope).toHaveBeenCalledWith("user-1", "org-2");
		expect(result).toMatchObject({
			ok: true,
			actor: { orgId: "org-2", ceiling: { scopes: ["read", "plan"], projectIds: ["p1", "p2"] } },
		});
	});

	it("refuses when the grant's organization is not the one the person resolves into", async () => {
		const d = deps({
			readGrant: vi.fn(async () => ({ orgId: "org-left", scopes: ["read" as const], projectIds: null })),
			resolveScope: vi.fn(async (userId: string) => ({ userId, orgId: "org-1" })),
		});
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "org_not_permitted" });
	});

	it("refuses when the token and the grant share no scope", async () => {
		const d = deps({
			readGrant: vi.fn(async () => ({ orgId: "org-1", scopes: ["destroy" as const], projectIds: null })),
		});
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "insufficient_scope" });
	});

	it("pins every call to the URL's project", async () => {
		const result = await resolveMcpActor(CLAIMS, "p9", deps());
		expect(result).toMatchObject({ ok: true, actor: { ceiling: { projectIds: ["p9"] } } });
	});

	it("refuses a pin outside the grant's projects; a pin never widens", async () => {
		const d = deps({
			readGrant: vi.fn(async () => ({ orgId: "org-1", scopes: ["read" as const], projectIds: ["p1"] })),
		});
		expect(await resolveMcpActor(CLAIMS, "p9", d)).toEqual({ ok: false, reason: "project_not_permitted" });
	});

	it("refuses every call while the organization's agent access is off (the kill switch)", async () => {
		const d = deps({ agentAccessEnabled: vi.fn(async () => false) });
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "agent_access_disabled" });
		expect(d.agentAccessEnabled).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1" }));
	});
});

describe("clientIdFromClaims", () => {
	it("reads azp, then client_id, and nothing else", () => {
		expect(clientIdFromClaims({ azp: "a", client_id: "b" })).toBe("a");
		expect(clientIdFromClaims({ client_id: "b" })).toBe("b");
		expect(clientIdFromClaims({ azp: "" })).toBeNull();
		expect(clientIdFromClaims({})).toBeNull();
	});
});
