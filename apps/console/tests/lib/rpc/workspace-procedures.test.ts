// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace read, moved from the server action onto the read router (#6114, ADR 0005 D1).
//
// Mocked boundary: a thenable drizzle chain stands in for the membership query; getEntitlements and
// isBillingActive stay real. What is asserted beyond the moved behaviour (synthetic Personal,
// effective plan) is R3: the context describes the ACTOR's org — the one the address resolved —
// and never reads the session. The session lookup is mocked to throw, so any read of it fails the
// test rather than quietly answering.

import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({
	getOwnerScope: vi.fn(async () => {
		throw new Error("the workspace read must not consult the session");
	}),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { getServiceDb } from "@/lib/db";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import type { Actor } from "@/lib/authz/types";
import { readWorkspaceContext, workspaceRouter } from "@/lib/rpc/procedures/workspace";

/** A drizzle-ish chain that awaits to `rows`. */
function mockDb(rows: unknown[]): void {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		innerJoin: () => db,
		leftJoin: () => db,
		where: () => db,
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

/** An actor for user-1 on `orgId`, holding `entitlements` when given. */
function actor(orgId: string, entitlements?: Actor["entitlements"]): Actor {
	return { userId: "user-1", orgId, entitlements };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("readWorkspaceContext", () => {
	it("synthesizes a Personal workspace when the user has no org memberships", async () => {
		mockDb([]);
		const ctx = await readWorkspaceContext(actor("user-1"));
		expect(ctx.organizations).toHaveLength(1);
		expect(ctx.organizations[0]).toMatchObject({ id: "user-1", slug: "~", plan: "community", role: "owner" });
	});

	it("maps real orgs and downgrades the plan when the subscription isn't live", async () => {
		mockDb([
			{ id: "org-1", name: "Acme", slug: "acme", logo: null, role: "owner", plan: "team", status: "active" },
			{ id: "org-2", name: "Beta", slug: "beta", logo: null, role: "admin", plan: "team", status: "canceled" },
		]);
		const ctx = await readWorkspaceContext(actor("org-1"));
		expect(ctx.organizations.find((o) => o.id === "org-1")?.plan).toBe("team"); // live
		expect(ctx.organizations.find((o) => o.id === "org-2")?.plan).toBe("community"); // canceled → downgraded
	});

	it("keeps a slug-less org's slug null — never the personal `~`", async () => {
		mockDb([{ id: "org-3", name: "No Slug", slug: null, logo: null, role: "owner", plan: null, status: null }]);
		const ctx = await readWorkspaceContext(actor("org-3"));
		expect(ctx.organizations[0]).toMatchObject({ id: "org-3", slug: null, plan: "community", status: "none" });
	});

	it("describes the ACTOR's org — its id and entitlements — never the session's (R3)", async () => {
		mockDb([]);
		const held = { ...COMMUNITY_ENTITLEMENTS, byoRunners: true };
		const ctx = await readWorkspaceContext(actor("org-addressed", held));
		expect(ctx.activeOrgId).toBe("org-addressed");
		expect(ctx.entitlements).toEqual(held);
	});
});

describe("workspace.context over the read router", () => {
	it("serves the context of the actor the entry point resolved", async () => {
		mockDb([]);
		const client = createRouterClient(workspaceRouter, {
			context: { actor: actor("org-from-the-address") },
		});
		const ctx = await client.context();
		expect(ctx.activeOrgId).toBe("org-from-the-address");
	});
});
