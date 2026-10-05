// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `ensureMemberGrant` is the one writer of a member's org-wide grant, so it is where "a member who
// is not active holds no grant" has to hold (#5465), and "a removed user is not granted again"
// (#5472). Before it, promoting a SUSPENDED member (the
// ee `afterUpdateMemberRole` hook) re-wrote their grant and the PDP let them back in.
//
// The database is a stand-in that records what was executed; the grant state against real
// Postgres is asserted in tests/integration/suspended-member-grants.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	/** The member rows the status read answers with. */
	const memberRows: { status: string }[][] = [];
	const execute = vi.fn(async () => []);
	const forUpdate = vi.fn(async () => memberRows.shift() ?? []);
	const tx = {
		select: () => tx,
		from: () => tx,
		where: () => tx,
		for: forUpdate,
		execute,
	};
	const db = {
		transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
		execute,
	};
	const syncMemberGrant = vi.fn(async () => undefined);
	return { memberRows, execute, forUpdate, db, syncMemberGrant };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => h.db }));
vi.mock("@/lib/authz/tuple-sync", () => ({
	getTupleSync: () => ({ syncMemberGrant: h.syncMemberGrant }),
}));

import { ensureMemberGrant } from "@/lib/authz/grants";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
	vi.clearAllMocks();
	h.memberRows.length = 0;
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ensureMemberGrant — only an active member is granted (#5465)", () => {
	it.each(["suspended", "deactivated"])(
		"writes NO grant for a %s member and mirrors nothing — while an active member and a user with no member row are granted",
		async (status) => {
			h.memberRows.push([{ status }]);
			await ensureMemberGrant(ORG, USER, "owner");
			expect(h.forUpdate).toHaveBeenCalledWith("update");
			expect(h.execute).not.toHaveBeenCalled();
			expect(h.syncMemberGrant).not.toHaveBeenCalled();

			// The control, through the same stand-in: an active member gets the delete of the old
			// org-scope grant and the insert of the new one.
			h.memberRows.push([{ status: "active" }]);
			await ensureMemberGrant(ORG, USER, "admin");
			expect(h.execute).toHaveBeenCalledTimes(2);
			expect(h.syncMemberGrant).toHaveBeenLastCalledWith(ORG, USER, "admin");
		},
	);
});

describe("ensureMemberGrant — a user with no member row (#5472)", () => {
	// The removal race: `afterUpdateMemberRole` running after a concurrent removal deleted the row
	// found no row, and the old fallback granted the removed user again.
	it("writes NO grant in an org where the user has no member row, and still grants their PERSONAL scope", async () => {
		h.memberRows.push([]);
		await ensureMemberGrant(ORG, USER, "admin");
		expect(h.execute).not.toHaveBeenCalled();
		expect(h.syncMemberGrant).not.toHaveBeenCalled();

		// The control: the personal scope (org id = user id) has no member row by design.
		h.memberRows.push([]);
		await ensureMemberGrant(USER, USER, "owner");
		expect(h.execute).toHaveBeenCalledTimes(2);
		expect(h.syncMemberGrant).toHaveBeenLastCalledWith(USER, USER, "owner");
	});
});
