// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the workspace action: stub the session lookup + a thenable drizzle
// chain, and assert the membership gate on org switching. The workspace READ moved to the read
// router (#6114); its tests are tests/lib/rpc/workspace-procedures.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { setActiveOrganization } from "@/app/server/actions/workspace";
import { getOwnerScope } from "@/lib/auth/owner";
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
