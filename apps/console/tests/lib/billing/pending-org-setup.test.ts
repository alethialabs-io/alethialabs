// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// lib/billing/pending-org-setup.ts (#5445) — the server-side record of a paid create-a-team setup,
// and the organization-create hooks that make its marker a server fact.
//
// The database is a queue here: each awaited query pops the next result. That pins the BRANCHING —
// which org is adopted, when a member row is repaired, when a create is refused — but not the SQL
// predicates themselves; tests/integration/pending-org-setups.test.ts runs those against Postgres.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn() }));

import { ensureMemberGrant } from "@/lib/authz/grants";
import {
	NEW_ORG_SETUP_IN_PROGRESS_CODE,
	NEW_ORG_SETUP_ORG_EXISTS_CODE,
} from "@/lib/billing/new-org-setup";
import {
	findSetupOrg,
	forgetPendingOrgSetup,
	keepStoredNewOrgMarker,
	type PendingOrgSetupRow,
	recordNewOrgCreated,
	stampNewOrgMetadata,
} from "@/lib/billing/pending-org-setup";
import { getServiceDb } from "@/lib/db";

/** A thenable drizzle-ish chain whose terminal `await` pops the next queued result set. */
function makeDb() {
	const queue: unknown[][] = [];
	const chain: Record<string, unknown> = {};
	for (const m of ["from", "where", "limit", "orderBy", "set", "values", "onConflictDoNothing", "innerJoin", "returning"]) {
		chain[m] = () => chain;
	}
	chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
		Promise.resolve(queue.shift() ?? []).then(resolve, reject);
	const db = {
		select: vi.fn(() => chain),
		update: vi.fn(() => chain),
		insert: vi.fn(() => chain),
		delete: vi.fn(() => chain),
		execute: vi.fn(async () => []),
	};
	return { db, queue };
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
	vi.clearAllMocks();
	db = makeDb();
	vi.mocked(getServiceDb).mockReturnValue(db.db as never);
});

/** A setup record owned by user-1 for sub_1, with `overrides`. */
function row(overrides: Partial<PendingOrgSetupRow> = {}): PendingOrgSetupRow {
	return {
		id: "row-1",
		user_id: "user-1",
		subscription_id: "sub_1",
		customer_id: "cus_1",
		intended_name: "Acme Cloud",
		intended_slug: "acme",
		billing: null,
		created_org_id: null,
		creating_at: null,
		linked_at: null,
		declared_at: null,
		created_at: new Date("2026-10-03T12:00:00Z"),
		updated_at: new Date("2026-10-03T12:00:00Z"),
		...overrides,
	};
}

/** Org metadata JSON as the server-side hook stamps it. */
function marked(sub: string, by: string): string {
	return JSON.stringify({ newOrgSubscriptionId: sub, newOrgCreatedBy: by });
}

describe("findSetupOrg — the org is found without the owner member row", () => {
	// better-auth inserts the org, then the member, in separate statements. When the member insert
	// failed, the 49030b809 lookup (a join on an OWNER member) could not see the org and the resume
	// created a SECOND one. Here the org is found by the record and the owner is repaired.
	it("an org with NO members (the member insert failed) is repaired with the payer as owner, not made again", async () => {
		db.queue.push([{ id: "org-made", slug: "acme" }]); // the org the record names
		db.queue.push([]); // its members: none
		db.queue.push([{ role: "owner" }]); // after the guarded insert

		await expect(findSetupOrg(row({ created_org_id: "org-made" }), "user-1")).resolves.toEqual({
			id: "org-made",
			slug: "acme",
		});
		expect(db.db.execute).toHaveBeenCalledTimes(1);
		expect(ensureMemberGrant).toHaveBeenCalledWith("org-made", "user-1", "owner");
	});

	it("with no created_org_id yet, adopts the org whose SERVER-STAMPED marker names this user — not one stamped for another", async () => {
		db.queue.push([
			{ id: "org-forged", slug: "x", metadata: marked("sub_1", "user-2") },
			{ id: "org-mine", slug: "acme", metadata: marked("sub_1", "user-1") },
		]);
		db.queue.push([{ userId: "user-1" }]); // members: the payer is in it
		db.queue.push([]); // the update recording created_org_id

		await expect(findSetupOrg(row(), "user-1")).resolves.toEqual({ id: "org-mine", slug: "acme" });
		expect(db.db.update).toHaveBeenCalledTimes(1);
		expect(db.db.execute).not.toHaveBeenCalled();
	});

	it("never joins the payer to an org that has OTHER members, nor records it as theirs", async () => {
		db.queue.push([{ id: "org-made", slug: "acme" }]);
		db.queue.push([{ userId: "user-2" }]);

		await expect(findSetupOrg(row({ created_org_id: "org-made" }), "user-1")).resolves.toBeNull();
		expect(db.db.execute).not.toHaveBeenCalled();
		expect(ensureMemberGrant).not.toHaveBeenCalled();

		db.queue.push([{ id: "org-theirs", slug: "x", metadata: marked("sub_1", "user-1") }]);
		db.queue.push([{ userId: "user-2" }]);
		await expect(findSetupOrg(row(), "user-1")).resolves.toBeNull();
		expect(db.db.update).not.toHaveBeenCalled();
	});

	it("answers null for a record that is not the caller's, without reading anything", async () => {
		await expect(findSetupOrg(row({ user_id: "user-2" }), "user-1")).resolves.toBeNull();
		expect(db.db.select).not.toHaveBeenCalled();
	});

	it("answers null when nothing was created for the setup yet", async () => {
		db.queue.push([]);
		await expect(findSetupOrg(row(), "user-1")).resolves.toBeNull();
	});
});

describe("stampNewOrgMetadata — the marker is the server's, not the browser's", () => {
	it("leaves a create carrying neither key alone", async () => {
		await expect(stampNewOrgMetadata({ region: "eu" }, "user-1")).resolves.toBeNull();
		await expect(stampNewOrgMetadata(undefined, "user-1")).resolves.toBeNull();
		expect(db.db.select).not.toHaveBeenCalled();
	});

	it("keeps the marker for the record's owner and stamps the creator from the session, over any value sent", async () => {
		db.queue.push([row()]); // the caller's record for sub_1
		db.queue.push([{ id: "row-1" }]); // the claim: this create got it
		db.queue.push([]); // no org marked for it yet
		await expect(
			stampNewOrgMetadata({ newOrgSubscriptionId: "sub_1", newOrgCreatedBy: "someone-else", region: "eu" }, "user-1"),
		).resolves.toEqual({
			metadata: { region: "eu", newOrgSubscriptionId: "sub_1", newOrgCreatedBy: "user-1" },
		});
	});

	it("strips a marker naming a setup the caller does not own", async () => {
		db.queue.push([]); // no record of the caller's for sub_victim
		await expect(
			stampNewOrgMetadata({ newOrgSubscriptionId: "sub_victim", newOrgCreatedBy: "victim" }, "user-1"),
		).resolves.toEqual({ metadata: undefined });
	});

	it("refuses a second org for a setup that already has one", async () => {
		db.queue.push([row({ created_org_id: "org-made" })]);
		await expect(stampNewOrgMetadata({ newOrgSubscriptionId: "sub_1" }, "user-1")).resolves.toEqual({
			refusal: { code: NEW_ORG_SETUP_ORG_EXISTS_CODE, message: expect.any(String) },
		});
	});

	it("refuses when an org already carries the marker but its created_org_id was never recorded", async () => {
		db.queue.push([row()]);
		db.queue.push([{ id: "row-1" }]); // the claim
		db.queue.push([{ id: "org-made", slug: "acme", metadata: marked("sub_1", "user-1") }]);
		await expect(stampNewOrgMetadata({ newOrgSubscriptionId: "sub_1" }, "user-1")).resolves.toMatchObject({
			refusal: { code: NEW_ORG_SETUP_ORG_EXISTS_CODE },
		});
	});
});

describe("stampNewOrgMetadata — one create per charge at a time (the claim)", () => {
	// The claim is one conditional UPDATE; the race itself is pinned against Postgres in
	// tests/integration/pending-org-setups.test.ts. Here: what a create that LOST the claim is told.
	it("a create that loses the claim is refused as in progress — retryable — and not let through", async () => {
		db.queue.push([row()]);
		db.queue.push([]); // the claim: another create holds it
		db.queue.push([row()]); // re-read: still no org recorded
		await expect(stampNewOrgMetadata({ newOrgSubscriptionId: "sub_1" }, "user-1")).resolves.toEqual({
			refusal: { code: NEW_ORG_SETUP_IN_PROGRESS_CODE, message: expect.any(String) },
		});
		expect(db.db.update).toHaveBeenCalledTimes(1);
	});

	it("a create that loses the claim to one that has since FINISHED is told the team exists", async () => {
		db.queue.push([row()]);
		db.queue.push([]);
		db.queue.push([row({ created_org_id: "org-made" })]);
		await expect(stampNewOrgMetadata({ newOrgSubscriptionId: "sub_1" }, "user-1")).resolves.toMatchObject({
			refusal: { code: NEW_ORG_SETUP_ORG_EXISTS_CODE },
		});
	});
});

describe("forgetPendingOrgSetup — a record goes only for an unpaid subscription the actor minted", () => {
	it.each(["active", "trialing", "past_due", "canceled", "unpaid", "paused"])(
		"keeps the record of a %s subscription",
		async (status) => {
			await expect(
				forgetPendingOrgSetup("user-1", { id: "sub_1", status, metadata: { created_by: "user-1" } }),
			).resolves.toBe(false);
			expect(db.db.delete).not.toHaveBeenCalled();
		},
	);

	it("keeps the record of a subscription someone else minted, even an unpaid one", async () => {
		await expect(
			forgetPendingOrgSetup("user-1", { id: "sub_1", status: "incomplete", metadata: { created_by: "user-2" } }),
		).resolves.toBe(false);
		expect(db.db.delete).not.toHaveBeenCalled();
	});

	it.each(["incomplete", "incomplete_expired"])("drops the record of the actor's %s subscription", async (status) => {
		await expect(
			forgetPendingOrgSetup("user-1", { id: "sub_1", status, metadata: { created_by: "user-1" } }),
		).resolves.toBe(true);
		expect(db.db.delete).toHaveBeenCalledTimes(1);
	});
});

describe("recordNewOrgCreated / keepStoredNewOrgMarker", () => {
	it("records the org only for a marker stamped for the same user", async () => {
		await recordNewOrgCreated("org-x", { newOrgSubscriptionId: "sub_1", newOrgCreatedBy: "user-2" }, "user-1");
		expect(db.db.update).not.toHaveBeenCalled();
		await recordNewOrgCreated("org-x", { newOrgSubscriptionId: "sub_1", newOrgCreatedBy: "user-1" }, "user-1");
		expect(db.db.update).toHaveBeenCalledTimes(1);
	});

	it("an update carries the STORED marker: a forged one is dropped, a real one survives a blob rewrite", async () => {
		db.queue.push([{ metadata: marked("sub_1", "user-1") }]);
		await expect(
			keepStoredNewOrgMarker("org-1", { description: "d", newOrgSubscriptionId: "sub_forged" }),
		).resolves.toEqual({
			metadata: { description: "d", newOrgSubscriptionId: "sub_1", newOrgCreatedBy: "user-1" },
		});
		db.queue.push([{ metadata: null }]);
		await expect(
			keepStoredNewOrgMarker("org-2", { newOrgSubscriptionId: "sub_victim", newOrgCreatedBy: "victim" }),
		).resolves.toEqual({ metadata: {} });
		await expect(keepStoredNewOrgMarker("org-3", undefined)).resolves.toBeNull();
	});
});
