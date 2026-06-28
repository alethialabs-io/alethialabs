// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the workspace actions: stub the scope resolvers + a thenable drizzle
// chain, keep getEntitlements/isBillingActive real, and assert the synthetic-Personal fallback,
// effective-plan logic, and the membership gate on org switching.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	getWorkspaceContext,
	setActiveOrganization,
} from "@/app/server/actions/workspace";
import { getOwnerScope } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getServiceDb } from "@/lib/db";

/** A drizzle-ish chain that awaits to `rows` and records `.update().set()` writes. */
function mockDb(rows: unknown[]) {
	const setSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		innerJoin: () => db,
		leftJoin: () => db,
		where: () => db,
		limit: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getActiveScope).mockResolvedValue({
		userId: "user-1",
		orgId: "user-1",
		entitlements: undefined,
	} as never);
});

describe("getWorkspaceContext", () => {
	it("synthesizes a Personal workspace when the user has no org memberships", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({ userId: "user-1", activeOrgId: "user-1" } as never);
		mockDb([]);
		const ctx = await getWorkspaceContext();
		expect(ctx.organizations).toHaveLength(1);
		expect(ctx.organizations[0]).toMatchObject({ id: "user-1", slug: "~", plan: "community", role: "owner" });
	});

	it("maps real orgs and downgrades the plan when the subscription isn't live", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({ userId: "user-1", activeOrgId: "org-1" } as never);
		mockDb([
			{ id: "org-1", name: "Acme", slug: "acme", logo: null, role: "owner", plan: "team", status: "active" },
			{ id: "org-2", name: "Beta", slug: "beta", logo: null, role: "admin", plan: "team", status: "canceled" },
		]);
		const ctx = await getWorkspaceContext();
		expect(ctx.organizations.find((o) => o.id === "org-1")?.plan).toBe("team"); // live
		expect(ctx.organizations.find((o) => o.id === "org-2")?.plan).toBe("community"); // canceled → downgraded
	});
});

describe("setActiveOrganization", () => {
	it("allows switching to the personal scope without a membership check", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({ userId: "user-1", sessionId: "s-1" } as never);
		mockDb([]); // no membership rows needed
		expect(await setActiveOrganization("user-1")).toEqual({ ok: true });
	});

	it("rejects switching to an org the user doesn't belong to", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({ userId: "user-1", sessionId: "s-1" } as never);
		mockDb([]); // membership lookup returns no row
		await expect(setActiveOrganization("org-x")).rejects.toThrow(/Not a member/);
	});

	it("persists the active org for a member", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({ userId: "user-1", sessionId: "s-1" } as never);
		const { setSpy } = mockDb([{ id: "m-1" }]); // membership exists
		expect(await setActiveOrganization("org-1")).toEqual({ ok: true });
		expect(setSpy).toHaveBeenCalledWith({ activeOrganizationId: "org-1" });
	});
});
