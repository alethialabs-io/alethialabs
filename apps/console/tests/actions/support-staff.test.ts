// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the staff support actions. Stubs assertStaff (the allowlist
// gate), the notifiers, the staff query builders, and a thenable getServiceDb chain (each
// await shifts the next seeded result set — mirrors tests/actions/support.test.ts). Covers
// the staff status machine: a public reply moves to pending_customer + notifies; an
// internal note inserts only (no status change, no notify); assignment notifies; and the
// resolve/close transitions fire the status-change notification, rejecting illegal jumps.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/support/staff", () => ({ assertStaff: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/support/staff-notify", () => ({
	notifyStaffReply: vi.fn(),
	notifyAssigned: vi.fn(),
	notifyStatusChange: vi.fn(),
}));
vi.mock("@/lib/queries/support", () => ({
	listCasesForStaff: vi.fn(),
	getCaseWithThreadForStaff: vi.fn(),
}));

import {
	assignCaseToMe,
	getStaffCase,
	listStaffCases,
	postStaffReply,
	staffCloseCase,
	staffResolveCase,
} from "@/app/server/actions/support-staff";
import { getServiceDb } from "@/lib/db";
import { assertStaff } from "@/lib/support/staff";
import {
	notifyAssigned,
	notifyStaffReply,
	notifyStatusChange,
} from "@/lib/support/staff-notify";
import {
	getCaseWithThreadForStaff,
	listCasesForStaff,
} from "@/lib/queries/support";

/** A thenable drizzle-ish chain; each `await` shifts the next seeded result set. */
function mockServiceDb(resultSets: unknown[][]) {
	const setSpy = vi.fn();
	const valuesSpy = vi.fn();
	const whereSpy = vi.fn();
	let i = 0;
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return db;
		},
		limit: () => db,
		orderBy: () => db,
		insert: () => db,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		returning: () => db,
		onConflictDoUpdate: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => {
			const r = i < resultSets.length ? resultSets[i] : (resultSets.at(-1) ?? []);
			i++;
			return resolve(r);
		},
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy, valuesSpy, whereSpy };
}

const CASE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(assertStaff).mockResolvedValue({
		userId: "staff-1",
		email: "ada@alethialabs.io",
		name: "Ada",
	});
	vi.mocked(notifyStaffReply).mockResolvedValue(undefined);
	vi.mocked(notifyAssigned).mockResolvedValue(undefined);
	vi.mocked(notifyStatusChange).mockResolvedValue(undefined);
});

describe("postStaffReply", () => {
	it("public reply: inserts a staff message, moves to pending_customer, notifies", async () => {
		const { setSpy, valuesSpy } = mockServiceDb([
			[{ status: "open" }], // select case status
			[{ id: "msg-1" }], // insert message … returning
			[], // update case
		]);

		const res = await postStaffReply({
			caseId: CASE_ID,
			body: "Looking into it now.",
		});

		expect(res).toEqual({ id: "msg-1" });
		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				case_id: CASE_ID,
				author_type: "staff",
				author_id: "staff-1",
				author_name: "Ada",
				is_internal: false,
			}),
		);
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "pending_customer",
				last_author_type: "staff",
			}),
		);
		expect(notifyStaffReply).toHaveBeenCalledWith(
			CASE_ID,
			expect.objectContaining({ author: "Ada" }),
		);
	});

	it("internal note: inserts is_internal, does NOT change status or notify", async () => {
		const { setSpy, valuesSpy } = mockServiceDb([
			[{ status: "open" }],
			[{ id: "msg-2" }],
		]);

		await postStaffReply({ caseId: CASE_ID, body: "check billing", isInternal: true });

		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({ is_internal: true, author_type: "staff" }),
		);
		expect(setSpy).not.toHaveBeenCalled(); // no case update
		expect(notifyStaffReply).not.toHaveBeenCalled();
	});

	it("throws when the case is missing (no insert)", async () => {
		const { valuesSpy } = mockServiceDb([[]]);
		await expect(
			postStaffReply({ caseId: CASE_ID, body: "hi" }),
		).rejects.toThrow(/Case not found/);
		expect(valuesSpy).not.toHaveBeenCalled();
	});

	it("rejects an invalid payload before touching the db", async () => {
		mockServiceDb([[]]);
		await expect(
			postStaffReply({ caseId: "not-a-uuid", body: "" } as never),
		).rejects.toThrow();
		expect(getServiceDb).not.toHaveBeenCalled();
	});
});

describe("assignment", () => {
	it("assignCaseToMe sets assigned_staff_id + notifies the customer", async () => {
		const { setSpy } = mockServiceDb([[]]);
		await assignCaseToMe(CASE_ID);
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ assigned_staff_id: "staff-1" }),
		);
		expect(notifyAssigned).toHaveBeenCalledWith(
			CASE_ID,
			expect.objectContaining({ agentName: "Ada" }),
		);
	});
});

describe("staff transitions", () => {
	it("staffResolveCase moves open → resolved (stamps resolved_at) + notifies", async () => {
		const { setSpy } = mockServiceDb([[{ status: "open" }], []]);
		await staffResolveCase(CASE_ID);
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "resolved", resolved_at: expect.any(Date) }),
		);
		expect(notifyStatusChange).toHaveBeenCalledWith(CASE_ID, "resolved");
	});

	it("staffCloseCase moves resolved → closed (stamps closed_at)", async () => {
		const { setSpy } = mockServiceDb([[{ status: "resolved" }], []]);
		await staffCloseCase(CASE_ID);
		expect(setSpy).toHaveBeenCalledWith(
			expect.objectContaining({ status: "closed", closed_at: expect.any(Date) }),
		);
		expect(notifyStatusChange).toHaveBeenCalledWith(CASE_ID, "closed");
	});

	it("throws on an illegal transition and does not write or notify", async () => {
		const { setSpy } = mockServiceDb([[{ status: "closed" }]]);
		await expect(staffResolveCase(CASE_ID)).rejects.toThrow(
			/Illegal support-case transition: closed → resolved/,
		);
		expect(setSpy).not.toHaveBeenCalled();
		expect(notifyStatusChange).not.toHaveBeenCalled();
	});
});

describe("staff reads", () => {
	it("listStaffCases maps `mine` to the staff user id", async () => {
		vi.mocked(listCasesForStaff).mockResolvedValue([]);
		await listStaffCases({ mine: true, status: "open" });
		expect(listCasesForStaff).toHaveBeenCalledWith(
			expect.anything(),
			"staff-1",
			expect.objectContaining({ assignedTo: "staff-1", status: "open" }),
		);
	});

	it("getStaffCase returns null (and skips the read watermark) when absent", async () => {
		vi.mocked(getCaseWithThreadForStaff).mockResolvedValue(null);
		mockServiceDb([[]]);
		const res = await getStaffCase(CASE_ID);
		expect(res).toBeNull();
	});
});
