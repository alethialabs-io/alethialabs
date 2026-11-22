// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What happens around an organization's deletion beyond Postgres's cascade
// (lib/org/deletion-teardown.ts).
//
// Pinned: the snapshot names every active member but the person deleting it and a subscription
// only while Stripe would still charge it; the finish cancels that subscription and emails each
// member, and a failure of either is logged rather than thrown, because the org is already gone.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb, whereParams } from "../../privacy/scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));
const { cancel, send, configured } = vi.hoisted(() => ({
	cancel: vi.fn(),
	send: vi.fn(),
	configured: vi.fn(),
}));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => ({ subscriptions: { cancel } }) }));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => configured() }));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: (...a: unknown[]) => send(...a) }));
vi.mock("@repo/email/config", () => ({
	getEmailConfig: () => ({ from: { general: "hello@example.io" }, configSet: { general: "general" } }),
}));

import { member } from "@/lib/db/schema";
import { finishOrgDeletion, snapshotOrgForDeletion } from "@/lib/org/deletion-teardown";

const SNAPSHOT = {
	orgId: "org-1",
	orgName: "Acme",
	teamIds: ["team-1"],
	recipients: ["a@example.io", "b@example.io"],
	stripeSubscriptionId: "sub_1",
};

beforeEach(() => {
	sdb.calls.length = 0;
	cancel.mockReset();
	cancel.mockResolvedValue({});
	send.mockReset();
	send.mockResolvedValue(undefined);
	configured.mockReset();
	configured.mockReturnValue(true);
});

describe("snapshotOrgForDeletion", () => {
	it("reads the teams, the members to tell and a live subscription, before the cascade", async () => {
		sdb.answer(
			[{ name: "Acme" }],
			[{ id: "team-1" }],
			[{ email: "a@example.io" }],
			[{ subscriptionId: "sub_1", status: "active" }],
		);
		expect(await snapshotOrgForDeletion("org-1", "owner-1")).toEqual({
			orgId: "org-1",
			orgName: "Acme",
			teamIds: ["team-1"],
			recipients: ["a@example.io"],
			stripeSubscriptionId: "sub_1",
		});
		// The person deleting the org is not emailed about it.
		const members = sdb.calls.find((c) => c.table === member);
		expect(whereParams(members)).toContain("owner-1");
	});

	it("names no subscription once it is cancelled", async () => {
		sdb.answer([{ name: "Acme" }], [], [], [{ subscriptionId: "sub_1", status: "canceled" }]);
		expect((await snapshotOrgForDeletion("org-1", "owner-1")).stripeSubscriptionId).toBeNull();
	});
});

describe("finishOrgDeletion", () => {
	it("cancels the subscription and emails every member", async () => {
		expect(await finishOrgDeletion(SNAPSHOT)).toEqual({ subscriptionCancelled: true, membersEmailed: 2 });
		expect(cancel).toHaveBeenCalledWith("sub_1", expect.anything());
		expect(send.mock.calls.map((c) => c[0].to)).toEqual(["a@example.io", "b@example.io"]);
	});

	it("still emails the members when the cancel fails, and says it was not cancelled", async () => {
		cancel.mockRejectedValue(new Error("stripe down"));
		expect(await finishOrgDeletion(SNAPSHOT)).toEqual({ subscriptionCancelled: false, membersEmailed: 2 });
	});

	it("does not throw when an email fails", async () => {
		send.mockRejectedValueOnce(new Error("ses down"));
		expect(await finishOrgDeletion({ ...SNAPSHOT, stripeSubscriptionId: null })).toEqual({
			subscriptionCancelled: false,
			membersEmailed: 1,
		});
		expect(cancel).not.toHaveBeenCalled();
	});
});
