// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5465: a role change must not leave an organization without an ACTIVE owner. The database is a
// stand-in that answers with the org's active member rows (the rule's query filters on
// `status = 'active'`; that filter is exercised against real Postgres in
// tests/integration/suspended-member-grants.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const activeRows: { id: string; role: string }[] = [];
	const db = {
		select: () => db,
		from: () => db,
		where: vi.fn(async () => activeRows),
	};
	return { activeRows, db };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => h.db }));

import {
	LAST_ACTIVE_OWNER_MESSAGE,
	roleChangeOwnerRefusal,
} from "@/lib/authz/active-owner";

const ORG = "org-1";

/** Seeds the org's ACTIVE members. */
function active(...rows: { id: string; role: string }[]): void {
	h.activeRows.length = 0;
	h.activeRows.push(...rows);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.activeRows.length = 0;
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
		// A suspended member is not among the active rows, so changing them changes no active owner.
		expect(await roleChangeOwnerRefusal(ORG, "m-suspended", "viewer")).toBeNull();
	});
});
