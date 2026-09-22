// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The three privacy-case READERS, and the gate each one did not have (#4854).
//
// A `"use server"` module's exports are POST endpoints whether or not anything in the product
// calls them, and nothing calls these. Before this change:
//
//   privacyCaseHistory     took a reference and checked nothing, so the complete ledger of any
//                          request — every decision, every reason, every actor — was readable by
//                          anyone who could quote or guess one.
//   overduePrivacyCases    took NO argument and checked nothing: every open case in the
//                          deployment, across every tenant.
//   unreplayedTombstones   took NO argument and checked nothing: every erasure ever performed,
//                          with its subject hash, erased user id, case reference and scope.
//
// So the assertions here are about the GATE and about the WHERE, not about the rows coming back: a
// test that only checked the call resolved would have passed on all three of the above.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeInOrg: vi.fn(),
	currentActor: vi.fn(),
}));
let injected: { userId: string; orgId: string } | undefined;
vi.mock("@/lib/authz/actor-context", () => ({
	getInjectedActor: () => injected,
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

// Drizzle stays real; only the operators the readers build their WHERE from are spied, so an
// assertion can name the COLUMN and the VALUE a predicate was built against.
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return { ...actual, eq: vi.fn(actual.eq), or: vi.fn(actual.or) };
});

import { eq } from "drizzle-orm";
import {
	overduePrivacyCases,
	privacyCaseHistory,
	unreplayedTombstones,
} from "@/app/server/actions/privacy/cases";
import { authorize, authorizeInOrg, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { privacyCase, privacyErasureTombstone } from "@/lib/db/schema";

const CALLER = "99999999-9999-9999-9999-999999999999";
const ORG = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";

/** A thenable drizzle chain that resolves to `rows`, whatever it is asked to join or order by. */
function mockDb(rows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		where: () => db,
		orderBy: () => db,
		limit: () => db,
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	// The call LOG is the assertion "it read nothing", so it starts empty for each test. The
	// return value set above survives a mockClear; only the recorded calls are dropped.
	vi.mocked(getServiceDb).mockClear();
}

/** Every (column, value) pair `eq` was called with, as plain strings. */
function eqPairs(): [unknown, unknown][] {
	return vi.mocked(eq).mock.calls.map(([col, val]) => [col, val]);
}

beforeEach(() => {
	vi.mocked(eq).mockClear();
	vi.mocked(authorize).mockReset();
	vi.mocked(authorizeInOrg).mockReset();
	vi.mocked(currentActor).mockReset();
	injected = undefined;
	vi.mocked(authorize).mockResolvedValue({ userId: CALLER, orgId: ORG });
	vi.mocked(currentActor).mockResolvedValue({ userId: CALLER, orgId: ORG });
	mockDb([]);
});

describe("overduePrivacyCases", () => {
	it("is gated, and asks only for cases the caller has standing over", async () => {
		await overduePrivacyCases(new Date("2026-09-22T00:00:00.000Z"));
		expect(authorize).toHaveBeenCalledWith("view", { type: "org" });
		// The two grounds, as a predicate: the caller's organization, or their own case.
		expect(eqPairs()).toContainEqual([privacyCase.organizationId, ORG]);
		expect(eqPairs()).toContainEqual([privacyCase.subjectUserId, CALLER]);
	});

	it("reads nothing when the gate refuses", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Forbidden"));
		await expect(overduePrivacyCases()).rejects.toThrow(/Forbidden/);
		expect(getServiceDb).not.toHaveBeenCalled();
	});
});

describe("unreplayedTombstones", () => {
	// A tombstone carries no organization of its own — it outlives the case — so the scope comes
	// from the case it names. Left-joined, so a tombstone whose case is gone is not the caller's.
	it("is gated, and scopes through the case the tombstone names", async () => {
		await unreplayedTombstones();
		expect(authorize).toHaveBeenCalledWith("view", { type: "org" });
		expect(eqPairs()).toContainEqual([
			privacyCase.reference,
			privacyErasureTombstone.caseReference,
		]);
		expect(eqPairs()).toContainEqual([privacyCase.organizationId, ORG]);
		expect(eqPairs()).toContainEqual([
			privacyErasureTombstone.erasedUserId,
			CALLER,
		]);
	});

	it("reads nothing when the gate refuses", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Forbidden"));
		await expect(unreplayedTombstones()).rejects.toThrow(/Forbidden/);
		expect(getServiceDb).not.toHaveBeenCalled();
	});
});

describe("privacyCaseHistory", () => {
	it("refuses a case that is neither the caller's own nor their organization's", async () => {
		mockDb([{ id: "case-1", subjectUserId: OTHER, organizationId: null }]);
		await expect(privacyCaseHistory("DSR-ABCD1234")).rejects.toThrow(/not yours/);
		expect(authorizeInOrg).not.toHaveBeenCalled();
	});

	it("answers an unknown reference exactly as it answers one you may not touch", async () => {
		mockDb([]);
		await expect(privacyCaseHistory("DSR-ABCD1234")).rejects.toThrow(/not yours/);
	});

	it("proves org:edit in the CASE's organization before reading the ledger", async () => {
		mockDb([{ id: "case-1", subjectUserId: OTHER, organizationId: ORG }]);
		vi.mocked(authorizeInOrg).mockResolvedValue({ userId: CALLER, orgId: ORG });
		await privacyCaseHistory("DSR-ABCD1234");
		expect(authorizeInOrg).toHaveBeenCalledWith(
			"edit",
			{ type: "org", id: ORG },
			ORG,
		);
	});

	it("refuses a reference that is not shaped like one", async () => {
		await expect(privacyCaseHistory("../../etc/passwd")).rejects.toThrow(
			/Not a privacy request reference/,
		);
	});
});
