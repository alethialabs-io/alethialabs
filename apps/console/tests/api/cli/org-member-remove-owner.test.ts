// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// DELETE /api/cli/orgs/:id/members/:memberId never removes an owner, and reads "owner" the way the
// PDP does (#5472). The old `role === "owner"` let an `owner,admin` member be removed, which could
// take the org's last owner with them.

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	rows: [{ userId: "user-2", role: "owner,admin" }],
	deleteSpy: vi.fn(),
	revokeMemberGrant: vi.fn(async () => undefined),
}));

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: async () => ({ actor: { userId: "user-1", orgId: "org-1" }, credential: {} }),
	ensureCliOrgAccess: async () => null,
}));
vi.mock("@/lib/authz/grants", () => ({ revokeMemberGrant: h.revokeMemberGrant }));
// The team-row and invitation writes are integration-tested (suspended-member-remaining.test.ts).
vi.mock("@/lib/authz/member-exit", () => ({
	cancelPendingInvitationsFrom: async () => undefined,
	deleteOrgTeamMemberships: async () => undefined,
}));
vi.mock("@/lib/db", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["from", "where", "limit"]) chain[m] = () => chain;
	chain.then = (resolve: (v: unknown) => void) => resolve(h.rows);
	const writer = {
		delete: () => {
			h.deleteSpy();
			return { where: async () => undefined };
		},
	};
	return {
		getServiceDb: () => ({
			select: () => chain,
			...writer,
			transaction: async (fn: (tx: typeof writer) => Promise<void>) => fn(writer),
		}),
	};
});

import { DELETE } from "@/app/api/cli/orgs/[id]/members/[memberId]/route";

/** Calls the route the way `alethia orgs members remove` does. */
function remove(): Promise<Response> {
	return DELETE(
		new Request("https://console.local/api/cli/orgs/org-1/members/member-2", {
			method: "DELETE",
		}),
		{ params: Promise.resolve({ id: "org-1", memberId: "member-2" }) },
	);
}

describe("DELETE /api/cli/orgs/:id/members/:memberId — owners (#5472)", () => {
	it("refuses removing an `owner,admin` member and deletes nothing; an admin is removed", async () => {
		h.rows = [{ userId: "user-2", role: "owner,admin" }];
		const res = await remove();
		expect(res.status).toBe(400);
		expect(h.deleteSpy).not.toHaveBeenCalled();
		expect(h.revokeMemberGrant).not.toHaveBeenCalled();

		// The control: a member who is not an owner is removed and their grants revoked.
		h.rows = [{ userId: "user-2", role: "admin" }];
		const ok = await remove();
		expect(ok.status).toBe(200);
		expect(h.deleteSpy).toHaveBeenCalledTimes(1);
		expect(h.revokeMemberGrant).toHaveBeenCalledWith("org-1", "user-2");
	});
});
