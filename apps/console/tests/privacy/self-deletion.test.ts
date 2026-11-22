// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Self-serve account deletion with a 14-day grace period (lib/privacy/self-deletion.ts).
//
// What is pinned, each a property the module states:
//   · the pre-checks refuse with a reason a person can act on — live resources, a shared team they
//     alone own, a paid subscription — and schedule nothing;
//   · scheduling opens a verified erasure case 14 days out, stores only the HASH of the cancel
//     token, emails the token itself, and signs the account out everywhere only AFTER the commit
//     (a failed email opens nothing and signs nobody out);
//   · an already-scheduled deletion keeps its date;
//   · a cancel withdraws the case through a conditional update and tells the person;
//   · the sweep claims each case before acting, sends the reminder once, runs the erasure as an
//     automated actor (null) when the grace period has passed, and keeps a refused erasure open.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb, whereParams, whereSql } from "./scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));

const { findLiveResidency, performErasure, sendAccountDeletionEmail } = vi.hoisted(() => ({
	findLiveResidency: vi.fn(),
	performErasure: vi.fn(),
	sendAccountDeletionEmail: vi.fn(),
}));
vi.mock("@/lib/privacy/erasure-executor", () => ({
	findLiveResidency: (...a: unknown[]) => findLiveResidency(...a),
	residencyIsClear: (r: { projects: number; environments: number; cloudConnections: number }) =>
		r.projects === 0 && r.environments === 0 && r.cloudConnections === 0,
	describeResidency: () => "Erasure is not performed while the personal organization still has 1 project.",
}));
vi.mock("@/lib/privacy/erasure", () => ({ performErasure: (...a: unknown[]) => performErasure(...a) }));
vi.mock("@/lib/privacy/emails", () => ({
	sendAccountDeletionEmail: (...a: unknown[]) => sendAccountDeletionEmail(...a),
}));
vi.mock("@/lib/authz/org-access-control", () => ({
	toPdpRole: (role: string) => (role.split(",").includes("owner") ? "owner" : "viewer"),
}));

import { privacyCase, privacyCaseEvent, session } from "@/lib/db/schema";
import { hashLinkToken } from "@/lib/privacy/link-token";
import {
	cancelScheduledErasure,
	deletionBlockers,
	ERASURE_GRACE_DAYS,
	scheduledErasureByToken,
	scheduleSelfErasure,
	sweepScheduledErasures,
} from "@/lib/privacy/self-deletion";

const USER = "11111111-1111-1111-1111-111111111111";
const TEAM = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const CLEAR = { projects: 0, environments: 0, cloudConnections: 0, soleOwnedOrganizations: 0 };
const SUBJECT = { userId: USER, email: "ada@example.io" };

beforeEach(() => {
	sdb.calls.length = 0;
	findLiveResidency.mockReset();
	findLiveResidency.mockResolvedValue(CLEAR);
	performErasure.mockReset();
	sendAccountDeletionEmail.mockReset();
	sendAccountDeletionEmail.mockResolvedValue(undefined);
});

/** The ops recorded for one table. */
function on(table: unknown, op?: string) {
	return sdb.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
}

describe("deletionBlockers", () => {
	it("is empty for an account that owns nothing live, shares nothing and pays for nothing", async () => {
		// member rows (personal org only), billed orgs
		sdb.answer([{ orgId: USER, role: "owner" }], []);
		expect(await deletionBlockers(USER)).toEqual([]);
	});

	it("names live resources with the erasure's own refusal text", async () => {
		findLiveResidency.mockResolvedValue({ ...CLEAR, projects: 1 });
		sdb.answer([{ orgId: USER, role: "owner" }], []);
		const blockers = await deletionBlockers(USER);
		expect(blockers.map((b) => b.code)).toEqual(["live_resources"]);
		expect(blockers[0]?.message).toContain("1 project");
	});

	it("refuses while the account is the only owner of a team with other members", async () => {
		sdb.answer(
			[
				{ orgId: USER, role: "owner" },
				{ orgId: TEAM, role: "owner" },
			],
			// the team's active members: the subject and one viewer
			[
				{ orgId: TEAM, userId: USER, role: "owner" },
				{ orgId: TEAM, userId: "someone", role: "viewer" },
			],
			[{ name: "Acme" }],
			[],
		);
		const blockers = await deletionBlockers(USER);
		expect(blockers.map((b) => b.code)).toEqual(["shared_org_owner"]);
		expect(blockers[0]?.message).toContain('"Acme"');
	});

	it("does not refuse a team that has another active owner", async () => {
		sdb.answer(
			[{ orgId: TEAM, role: "owner,admin" }],
			[
				{ orgId: TEAM, userId: USER, role: "owner" },
				{ orgId: TEAM, userId: "other", role: "owner" },
			],
			[],
		);
		expect(await deletionBlockers(USER)).toEqual([]);
	});

	it("refuses while an organization the account owns has a paid subscription", async () => {
		sdb.answer([{ orgId: USER, role: "owner" }], [{ orgId: USER, name: "Ada" }]);
		const blockers = await deletionBlockers(USER);
		expect(blockers.map((b) => b.code)).toEqual(["paid_subscription"]);
		// A card-less trial is not a paid subscription: only active and past_due are asked about.
		const billed = sdb.calls.at(-1);
		expect(whereSql(billed)).toContain('"status" in ($');
		expect(whereParams(billed)).toContain("active");
		expect(whereParams(billed)).not.toContain("trialing");
	});
});

describe("scheduleSelfErasure", () => {
	it("schedules a verified erasure 14 days out, emails the cancel token and signs the account out", async () => {
		// open case lookup, member rows, billed orgs, insert … returning
		sdb.answer([], [{ orgId: USER, role: "owner" }], [], [{ id: "case-1" }]);
		const out = await scheduleSelfErasure(SUBJECT, NOW);

		if (out.outcome !== "scheduled") throw new Error(`expected scheduled, got ${out.outcome}`);
		const due = new Date(NOW.getTime() + ERASURE_GRACE_DAYS * 86_400_000);
		expect(out.scheduledFor).toEqual(due);

		const [insert] = on(privacyCase, "insert");
		expect(insert?.inTx).toBe(true);
		expect(insert?.values).toMatchObject({
			kind: "erasure",
			state: "in_review",
			subjectUserId: USER,
			organizationId: null,
			identityVerifiedAt: NOW,
			scheduledFor: due,
		});

		// The email carries the TOKEN; the case carries only its hash.
		const sent = sendAccountDeletionEmail.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ to: "ada@example.io", stage: "scheduled", at: due });
		const values: unknown = insert?.values;
		const stored =
			typeof values === "object" && values !== null && "linkTokenSha256" in values
				? values.linkTokenSha256
				: undefined;
		expect(stored).toBe(hashLinkToken(sent.cancelToken));
		expect(stored).not.toBe(sent.cancelToken);

		// The ledger: received, identity verified, scheduled.
		expect(on(privacyCaseEvent, "insert").map((c) => (c.values as { kind: string }).kind)).toEqual([
			"received",
			"identity_verified",
			"note",
		]);
		// Signed out everywhere, after the commit.
		const revoke = on(session, "delete");
		expect(revoke).toHaveLength(1);
		expect(revoke[0]?.inTx).toBe(false);
	});

	it("refuses with the blockers and schedules nothing", async () => {
		findLiveResidency.mockResolvedValue({ ...CLEAR, cloudConnections: 1 });
		sdb.answer([], [{ orgId: USER, role: "owner" }], []);
		const out = await scheduleSelfErasure(SUBJECT, NOW);
		expect(out.outcome).toBe("blocked");
		expect(on(privacyCase, "insert")).toEqual([]);
		expect(on(session, "delete")).toEqual([]);
		expect(sendAccountDeletionEmail).not.toHaveBeenCalled();
	});

	it("keeps the date of a deletion that is already scheduled", async () => {
		const scheduledFor = new Date("2026-11-30T00:00:00.000Z");
		sdb.answer([{ id: "case-1", reference: "DSR-00000001", scheduledFor }]);
		expect(await scheduleSelfErasure(SUBJECT, NOW)).toEqual({
			outcome: "already_scheduled",
			reference: "DSR-00000001",
			scheduledFor,
		});
		expect(sdb.calls.filter((c) => c.op !== "select")).toEqual([]);
	});

	it("signs nobody out when the confirmation email fails", async () => {
		sendAccountDeletionEmail.mockRejectedValue(new Error("ses down"));
		sdb.answer([], [{ orgId: USER, role: "owner" }], [], [{ id: "case-1" }]);
		await expect(scheduleSelfErasure(SUBJECT, NOW)).rejects.toThrow("ses down");
		expect(on(session, "delete")).toEqual([]);
	});
});

describe("cancelScheduledErasure", () => {
	it("withdraws the scheduled case, records why, and tells the person", async () => {
		// conditional update returning, event insert, address lookup
		sdb.answer([{ id: "case-1", reference: "DSR-00000001", subjectUserId: USER }], [], [{ email: "ada@example.io" }]);
		const out = await cancelScheduledErasure({ userId: USER }, "sign_in", NOW);
		expect(out).toEqual({ outcome: "cancelled", reference: "DSR-00000001" });

		const [update] = on(privacyCase, "update");
		expect(update?.set).toMatchObject({ state: "withdrawn", scheduledFor: null, linkTokenSha256: null });
		// Only a still-scheduled, still-open erasure matches.
		expect(whereSql(update)).toContain('"scheduled_for" is not null');
		expect((on(privacyCaseEvent, "insert")[0]?.values as { kind: string }).kind).toBe("withdrawn");
		expect(sendAccountDeletionEmail).toHaveBeenCalledWith(expect.objectContaining({ stage: "cancelled" }));
	});

	it("finds the case by the HASH of the emailed token", async () => {
		sdb.answer([]);
		const out = await cancelScheduledErasure({ token: "t".repeat(43) }, "link", NOW);
		expect(out).toEqual({ outcome: "nothing_scheduled" });
		expect(whereSql(on(privacyCase, "update")[0])).toContain('"link_token_sha256" = $');
		expect(sendAccountDeletionEmail).not.toHaveBeenCalled();
	});
});

describe("sweepScheduledErasures", () => {
	const scheduledFor = new Date("2026-11-20T00:00:00.000Z");
	const due = {
		id: "case-1",
		reference: "DSR-00000001",
		kind: "erasure",
		subjectUserId: USER,
		scheduledFor: null,
	};

	it("runs a due erasure as an automated step, after claiming it, and confirms it to the person", async () => {
		performErasure.mockResolvedValue({ outcome: "erased", tables: [], rowsErased: 3, rowsPseudonymized: 1, tablesRetained: 2 });
		// reminders: none; due list; claim; address
		sdb.answer([], [{ id: "case-1", scheduledFor }], [due], [{ email: "ada@example.io" }]);
		const out = await sweepScheduledErasures(NOW);
		expect(out).toEqual({ reminded: 0, erased: 1, refused: 0, failed: 0 });
		expect(performErasure).toHaveBeenCalledWith(due, null, NOW);
		const claim = on(privacyCase, "update")[0];
		expect(claim?.set).toMatchObject({ scheduledFor: null });
		expect(whereSql(claim)).toContain('"scheduled_for" = $');
		expect(sendAccountDeletionEmail).toHaveBeenCalledWith(expect.objectContaining({ stage: "deleted" }));
	});

	it("does nothing with a case another instance claimed first", async () => {
		sdb.answer([], [{ id: "case-1", scheduledFor }], []);
		const out = await sweepScheduledErasures(NOW);
		expect(out.erased).toBe(0);
		expect(performErasure).not.toHaveBeenCalled();
	});

	it("keeps a refused erasure open for the privacy team and says so", async () => {
		performErasure.mockResolvedValue({ outcome: "refused_live_resources", message: "x", residency: CLEAR });
		sdb.answer([], [{ id: "case-1", scheduledFor }], [due], [{ email: "ada@example.io" }]);
		const out = await sweepScheduledErasures(NOW);
		expect(out.refused).toBe(1);
		expect(sendAccountDeletionEmail).not.toHaveBeenCalled();
		const note = on(privacyCaseEvent, "insert").at(-1)?.values as { detail: { summary: string } };
		expect(note.detail.summary).toContain("stays open");
	});

	it("sends the reminder once, claimed by its own conditional update", async () => {
		const runsAt = new Date("2026-11-25T00:00:00.000Z");
		// reminder candidates; claim returning the row; address; event; due list
		sdb.answer(
			[{ id: "case-1" }],
			[{ ...due, scheduledFor: runsAt }],
			[{ email: "ada@example.io" }],
			[],
			[],
		);
		const out = await sweepScheduledErasures(NOW);
		expect(out.reminded).toBe(1);
		expect(whereSql(on(privacyCase, "update")[0])).toContain('"reminder_sent_at" is null');
		expect(sendAccountDeletionEmail).toHaveBeenCalledWith(
			expect.objectContaining({ stage: "reminder", at: runsAt }),
		);
		// The reminder carries no cancel link: the stored token is a hash and cannot be re-sent.
		expect(sendAccountDeletionEmail.mock.calls[0]?.[0].cancelToken).toBeUndefined();
	});
});

describe("the remaining paths", () => {
	it("schedules an erasure case that was already open, rather than opening a second", async () => {
		sdb.answer(
			[{ id: "case-old", reference: "DSR-00000009", scheduledFor: null, identityVerifiedAt: null }],
			[{ orgId: USER, role: "owner" }],
			[],
		);
		const out = await scheduleSelfErasure(SUBJECT, NOW);
		expect(out).toMatchObject({ outcome: "scheduled", reference: "DSR-00000009" });
		expect(on(privacyCase, "insert")).toEqual([]);
		expect(on(privacyCase, "update")[0]?.set).toMatchObject({ identityVerifiedAt: NOW, state: "in_review" });
	});

	it("refuses when the new case row cannot be written", async () => {
		sdb.answer([], [{ orgId: USER, role: "owner" }], [], []);
		await expect(scheduleSelfErasure(SUBJECT, NOW)).rejects.toThrow(/Could not open/);
	});

	it("cancels without an email when the account has no address any more", async () => {
		sdb.answer([{ id: "case-1", reference: "DSR-00000001", subjectUserId: USER }], [], []);
		expect((await cancelScheduledErasure({ userId: USER }, "link", NOW)).outcome).toBe("cancelled");
		expect(sendAccountDeletionEmail).not.toHaveBeenCalled();
	});

	it("still cancels when the cancelled email fails to send", async () => {
		sendAccountDeletionEmail.mockRejectedValue(new Error("ses down"));
		sdb.answer([{ id: "case-1", reference: "DSR-00000001", subjectUserId: USER }], [], [{ email: "ada@example.io" }]);
		expect((await cancelScheduledErasure({ userId: USER }, "sign_in", NOW)).outcome).toBe("cancelled");
	});

	it("finds a scheduled deletion by its token, and nothing for an unscheduled one", async () => {
		const scheduledFor = new Date("2026-12-05T00:00:00.000Z");
		sdb.answer([{ reference: "DSR-00000001", scheduledFor }]);
		expect(await scheduledErasureByToken("t".repeat(43))).toEqual({ reference: "DSR-00000001", scheduledFor });
		sdb.answer([{ reference: "DSR-00000001", scheduledFor: null }]);
		expect(await scheduledErasureByToken("t".repeat(43))).toBeNull();
	});

	it("re-arms a reminder whose email failed, and skips one with no address", async () => {
		const runsAt = new Date("2026-11-25T00:00:00.000Z");
		const row = { id: "case-1", reference: "DSR-00000001", subjectUserId: USER, scheduledFor: runsAt };
		sendAccountDeletionEmail.mockRejectedValueOnce(new Error("ses down"));
		sdb.answer([{ id: "case-1" }], [row], [{ email: "ada@example.io" }], [], []);
		expect((await sweepScheduledErasures(NOW)).reminded).toBe(0);
		expect(on(privacyCase, "update")[1]?.set).toEqual({ reminderSentAt: null });

		sdb.calls.length = 0;
		sdb.answer([{ id: "case-1" }], [row], [], []);
		expect((await sweepScheduledErasures(NOW)).reminded).toBe(0);
		expect(sendAccountDeletionEmail).toHaveBeenCalledTimes(1);
	});

	it("records a scheduled erasure that faults, and keeps it for the privacy team", async () => {
		performErasure.mockRejectedValue(new Error("db down"));
		const due = { id: "case-1", reference: "DSR-00000001", subjectUserId: USER, scheduledFor: null };
		sdb.answer([], [{ id: "case-1", scheduledFor: new Date("2026-11-20T00:00:00.000Z") }], [due], []);
		const out = await sweepScheduledErasures(NOW);
		expect(out.failed).toBe(1);
		const note = on(privacyCaseEvent, "insert").at(-1)?.values as { detail: { summary: string } };
		expect(note.detail.summary).toContain("failed with an error");
	});

	it("counts an erasure that ran even when its confirmation email fails", async () => {
		performErasure.mockResolvedValue({ outcome: "erased", tables: [], rowsErased: 1, rowsPseudonymized: 0, tablesRetained: 0 });
		sendAccountDeletionEmail.mockRejectedValue(new Error("ses down"));
		const due = { id: "case-1", reference: "DSR-00000001", subjectUserId: USER, scheduledFor: null };
		sdb.answer([], [{ id: "case-1", scheduledFor: new Date("2026-11-20T00:00:00.000Z") }], [due], [{ email: "ada@example.io" }]);
		expect((await sweepScheduledErasures(NOW)).erased).toBe(1);
	});
});
