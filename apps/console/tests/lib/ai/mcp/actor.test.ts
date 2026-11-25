// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The actor an MCP access token becomes (lib/ai/mcp/actor.ts), over stood-in reads: the ceiling it is
// held to, the organization the consent grant names, its projects, its revocation, the URL's project
// pin, and the kill switch.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withScope: vi.fn() }));
vi.mock("@/lib/agents/grant-binding", () => ({ readGrantBinding: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/approvals/context", () => ({ readAgentPolicy: vi.fn() }));

import type { AgentGrant, GrantBinding } from "@/lib/agents/grant-binding";
import { readGrantBinding } from "@/lib/agents/grant-binding";
import {
	clientIdFromClaims,
	defaultMcpActorDeps,
	type McpActorDeps,
	resolveMcpActor,
} from "@/lib/ai/mcp/actor";
import { readAgentPolicy } from "@/lib/approvals/context";
import { getServiceDb, withScope } from "@/lib/db";
import { txAnswering } from "./tx-stub";

/** A live binding to `grant`. */
function live(grant: AgentGrant): GrantBinding {
	return { kind: "live", grant };
}

/** Reads that answer a person in org-1 with no grant and agent access on, unless overridden. */
function deps(over: Partial<McpActorDeps> = {}): McpActorDeps {
	return {
		readGrant: vi.fn(async (): Promise<GrantBinding> => ({ kind: "none" })),
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
		const d = deps({ readGrant: vi.fn(async () => live(grant)) });
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
			readGrant: vi.fn(async () => live({ orgId: "org-left", scopes: ["read"], projectIds: null })),
			resolveScope: vi.fn(async (userId: string) => ({ userId, orgId: "org-1" })),
		});
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "org_not_permitted" });
	});

	it("refuses when the token and the grant share no scope", async () => {
		const d = deps({
			readGrant: vi.fn(async () => live({ orgId: "org-1", scopes: ["destroy"], projectIds: null })),
		});
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "insufficient_scope" });
	});

	it("pins every call to the URL's project", async () => {
		const result = await resolveMcpActor(CLAIMS, "p9", deps());
		expect(result).toMatchObject({ ok: true, actor: { ceiling: { projectIds: ["p9"] } } });
	});

	it("refuses a pin outside the grant's projects; a pin never widens", async () => {
		const d = deps({
			readGrant: vi.fn(async () => live({ orgId: "org-1", scopes: ["read"], projectIds: ["p1"] })),
		});
		expect(await resolveMcpActor(CLAIMS, "p9", d)).toEqual({ ok: false, reason: "project_not_permitted" });
	});

	it("answers grant_revoked when every grant to the client is revoked, before resolving any org", async () => {
		const d = deps({ readGrant: vi.fn(async (): Promise<GrantBinding> => ({ kind: "revoked" })) });
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "grant_revoked" });
		// A revoked grant must not fall back to the no-grant path (the person's default org, every project).
		expect(d.resolveScope).not.toHaveBeenCalled();
		expect(d.agentAccessEnabled).not.toHaveBeenCalled();
	});

	it("refuses the very next request after a disconnect, with the same token", async () => {
		let binding: GrantBinding = live({ orgId: "org-2", scopes: ["read"], projectIds: ["p1"] });
		const d = deps({ readGrant: vi.fn(async () => binding) });
		expect(await resolveMcpActor(CLAIMS, null, d)).toMatchObject({ ok: true, actor: { orgId: "org-2" } });
		binding = { kind: "revoked" };
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "grant_revoked" });
		expect(d.readGrant).toHaveBeenCalledTimes(2);
	});

	it("refuses a grant that records no organization rather than falling back to the person's own", async () => {
		const d = deps({ readGrant: vi.fn(async () => live({ orgId: "", scopes: ["read"], projectIds: null })) });
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "org_not_permitted" });
		expect(d.resolveScope).not.toHaveBeenCalled();
	});

	it("refuses a grant whose project list is empty rather than reading it as every project", async () => {
		const d = deps({ readGrant: vi.fn(async () => live({ orgId: "org-1", scopes: ["read"], projectIds: [] })) });
		expect(await resolveMcpActor(CLAIMS, null, d)).toEqual({ ok: false, reason: "project_not_permitted" });
	});

	it("holds an unpinned request to the grant's projects", async () => {
		const d = deps({ readGrant: vi.fn(async () => live({ orgId: "org-1", scopes: ["read"], projectIds: ["p1"] })) });
		expect(await resolveMcpActor(CLAIMS, null, d)).toMatchObject({ ok: true, actor: { ceiling: { projectIds: ["p1"] } } });
	});

	it("narrows a pin inside the grant's projects to that one project", async () => {
		const d = deps({ readGrant: vi.fn(async () => live({ orgId: "org-1", scopes: ["read"], projectIds: ["p1", "p2"] })) });
		expect(await resolveMcpActor(CLAIMS, "p2", d)).toMatchObject({ ok: true, actor: { ceiling: { projectIds: ["p2"] } } });
	});

	it("refuses a token that names no client: no grant can be read for it", async () => {
		const d = deps();
		expect(await resolveMcpActor({ sub: "user-1", scope: "read" }, null, d)).toEqual({ ok: false, reason: "no_client" });
		expect(d.readGrant).not.toHaveBeenCalled();
	});

	it("keeps a token with no grant row on the token's own scopes over every project", async () => {
		const d = deps();
		expect(await resolveMcpActor(CLAIMS, null, d)).toMatchObject({
			ok: true,
			actor: { orgId: "org-1", ceiling: { scopes: ["read", "plan", "apply"], projectIds: null } },
		});
		expect(d.resolveScope).toHaveBeenCalledWith("user-1");
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

describe("defaultMcpActorDeps", () => {
	it("reads the grant through the binding read, live, revoked or none", () => {
		expect(defaultMcpActorDeps.readGrant).toBe(readGrantBinding);
	});

	it("reads the organization's agent switch inside that person's tenancy scope", async () => {
		const tx = txAnswering();
		vi.mocked(withScope).mockImplementation(((_scope: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never);
		vi.mocked(readAgentPolicy).mockResolvedValue({ agentAccessEnabled: false } as never);
		expect(await defaultMcpActorDeps.agentAccessEnabled({ userId: "user-1", orgId: "org-1" })).toBe(false);
		expect(withScope).toHaveBeenCalledWith({ ownerId: "user-1", orgId: "org-1" }, expect.any(Function));
		expect(readAgentPolicy).toHaveBeenCalledWith(tx, "org-1");
	});
});

describe("readGrantBinding", () => {
	/** The real read, past this file's module stand-in for the actor's tests. */
	async function realRead() {
		return (await vi.importActual<typeof import("@/lib/agents/grant-binding")>("@/lib/agents/grant-binding"))
			.readGrantBinding;
	}

	it("answers a live grant as its org, scopes and projects", async () => {
		const db = txAnswering([{ org_id: "org-2", scopes: ["read", "plan"], project_ids: ["p1"], revoked_at: null }]);
		// The stub cannot satisfy drizzle's database type; the same shape addons-version.test.ts uses.
		vi.mocked(getServiceDb).mockReturnValue(db as never);
		expect(await (await realRead())("user-1", "client-1")).toEqual({
			kind: "live",
			grant: { orgId: "org-2", scopes: ["read", "plan"], projectIds: ["p1"] },
		});
		expect(db.select).toHaveBeenCalledTimes(1);
	});

	it("answers revoked when the row read first (live rows sort first) is revoked", async () => {
		const db = txAnswering([{ org_id: "org-2", scopes: ["read"], project_ids: null, revoked_at: new Date() }]);
		vi.mocked(getServiceDb).mockReturnValue(db as never);
		expect(await (await realRead())("user-1", "client-1")).toEqual({ kind: "revoked" });
	});

	it("answers none when the client has no grant row at all", async () => {
		vi.mocked(getServiceDb).mockReturnValue(txAnswering([]) as never);
		expect(await (await realRead())("user-1", "client-1")).toEqual({ kind: "none" });
	});
});
