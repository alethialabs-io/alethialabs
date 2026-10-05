// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5465: a role change must not leave an organization without an ACTIVE owner. #5472: nor may a
// removal or a leave, and a member who is not active may not be made an owner. The database is a
// stand-in that answers with the org's member rows; the same rules run against real Postgres in
// tests/integration/suspended-member-grants.test.ts and suspended-member-powers.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const rows: { id: string; role: string; status: string }[] = [];
	const db = {
		select: () => db,
		from: () => db,
		where: vi.fn(async () => rows),
	};
	return { rows, db };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => h.db }));

import {
	INACTIVE_OWNER_MESSAGE,
	LAST_ACTIVE_OWNER_MESSAGE,
	removalOwnerRefusal,
	roleChangeOwnerRefusal,
} from "@/lib/authz/active-owner";

const ORG = "org-1";

/** Seeds the org's members; a row without a status is active. */
function members(...rows: { id: string; role: string; status?: string }[]): void {
	h.rows.length = 0;
	h.rows.push(...rows.map((r) => ({ status: "active", ...r })));
}

/** Seeds the org's ACTIVE members. */
function active(...rows: { id: string; role: string }[]): void {
	members(...rows);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.rows.length = 0;
});

describe("roleChangeOwnerRefusal", () => {
	it("refuses demoting the only active owner", async () => {
		active({ id: "m-1", role: "owner" }, { id: "m-2", role: "admin" });
		expect(await roleChangeOwnerRefusal(ORG, "m-1", "admin")).toBe(
			LAST_ACTIVE_OWNER_MESSAGE,
		);
	});

	it("reads a comma-joined role the way the PDP does: `owner,admin` is an owner", async () => {
		active({ id: "m-1", role: "owner,admin" }, { id: "m-2", role: "viewer" });
		expect(await roleChangeOwnerRefusal(ORG, "m-1", "viewer")).toBe(
			LAST_ACTIVE_OWNER_MESSAGE,
		);
	});

	it("allows the demotion when another ACTIVE member is an owner", async () => {
		active({ id: "m-1", role: "owner" }, { id: "m-2", role: "admin, owner" });
		expect(await roleChangeOwnerRefusal(ORG, "m-1", "operator")).toBeNull();
	});

	it("never refuses a change TO owner, nor one on a member who is not an active owner", async () => {
		active({ id: "m-1", role: "owner" }, { id: "m-2", role: "admin" });
		expect(await roleChangeOwnerRefusal(ORG, "m-1", "owner,admin")).toBeNull();
		expect(await roleChangeOwnerRefusal(ORG, "m-2", "viewer")).toBeNull();
		// A suspended member is not an active owner, so changing them changes no active owner.
		members(
			{ id: "m-1", role: "owner" },
			{ id: "m-suspended", role: "owner", status: "suspended" },
		);
		expect(await roleChangeOwnerRefusal(ORG, "m-suspended", "viewer")).toBeNull();
	});

	// #5472: better-auth stores the role first and the grant writer refuses the suspended member, so
	// the org gained a suspended OWNER, whom better-auth's leave and remove checks count as an owner.
	it("refuses making a member who is not active an owner, and allows it for an active one", async () => {
		members(
			{ id: "m-1", role: "owner" },
			{ id: "m-suspended", role: "viewer", status: "suspended" },
			{ id: "m-2", role: "viewer" },
		);
		expect(await roleChangeOwnerRefusal(ORG, "m-suspended", "owner")).toBe(
			INACTIVE_OWNER_MESSAGE,
		);
		expect(await roleChangeOwnerRefusal(ORG, "m-suspended", "admin,owner")).toBe(
			INACTIVE_OWNER_MESSAGE,
		);
		expect(await roleChangeOwnerRefusal(ORG, "m-2", "owner")).toBeNull();
		// A non-owner role for the suspended member is not this rule's business.
		expect(await roleChangeOwnerRefusal(ORG, "m-suspended", "admin")).toBeNull();
	});
});

describe("removalOwnerRefusal (#5472)", () => {
	it("refuses removing the only ACTIVE owner even when a suspended owner remains, and allows the rest", async () => {
		members(
			{ id: "m-1", role: "owner,admin" },
			{ id: "m-2", role: "owner", status: "suspended" },
			{ id: "m-3", role: "admin" },
		);
		expect(await removalOwnerRefusal(ORG, "m-1")).toBe(LAST_ACTIVE_OWNER_MESSAGE);

		// The controls: a non-owner and the suspended owner may go, and so may an owner once another
		// ACTIVE member is one.
		expect(await removalOwnerRefusal(ORG, "m-3")).toBeNull();
		expect(await removalOwnerRefusal(ORG, "m-2")).toBeNull();
		members(
			{ id: "m-1", role: "owner" },
			{ id: "m-2", role: "admin, owner" },
		);
		expect(await removalOwnerRefusal(ORG, "m-1")).toBeNull();
	});
});
