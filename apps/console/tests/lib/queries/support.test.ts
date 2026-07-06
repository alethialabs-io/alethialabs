// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Query-builder tests for the support-case visibility filters. Drives a thenable drizzle-ish tx
// stub (each await shifts the next seeded result set) and spies on the real drizzle `inArray`/`eq`
// helpers to assert: listCasesForOwner buckets by the right status set (active vs resolved vs
// none), and getCaseWithThread strips is_internal staff notes and returns null for a missing case.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the real drizzle helpers with spies so we can assert how the WHERE was composed
// without depending on the opaque SQL object identity.
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		inArray: vi.fn(actual.inArray),
		eq: vi.fn(actual.eq),
	};
});

import { eq, inArray } from "drizzle-orm";
import {
	getCaseWithThread,
	listCasesForOwner,
} from "@/lib/queries/support";
import { supportCases, supportMessages } from "@/lib/db/schema";

/** A thenable drizzle-ish tx: each await shifts the next seeded result set. */
function mockTx(resultSets: unknown[][]) {
	const whereSpy = vi.fn();
	const orderBySpy = vi.fn();
	let i = 0;
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		select: () => tx,
		from: () => tx,
		leftJoin: () => tx,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return tx;
		},
		limit: () => tx,
		orderBy: (...a: unknown[]) => {
			orderBySpy(...a);
			return tx;
		},
		then: (resolve: (v: unknown) => void) => {
			const r = i < resultSets.length ? resultSets[i] : (resultSets.at(-1) ?? []);
			i++;
			return resolve(r);
		},
	});
	return { tx: tx as never, whereSpy, orderBySpy };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listCasesForOwner", () => {
	it("filters by the ACTIVE status set for { status: \"active\" }", async () => {
		const { tx, whereSpy, orderBySpy } = mockTx([[{ id: "c-1" }]]);
		const rows = await listCasesForOwner(tx, "owner-1", { status: "active" });
		expect(rows).toHaveLength(1);
		expect(inArray).toHaveBeenCalledWith(supportCases.status, [
			"open",
			"pending_support",
			"pending_customer",
		]);
		expect(whereSpy).toHaveBeenCalledTimes(1);
		expect(orderBySpy).toHaveBeenCalledTimes(1);
	});

	it("filters by the RESOLVED status set for { status: \"resolved\" }", async () => {
		const { tx } = mockTx([[]]);
		await listCasesForOwner(tx, "owner-1", { status: "resolved" });
		expect(inArray).toHaveBeenCalledWith(supportCases.status, ["resolved", "closed"]);
	});

	it("applies no status filter when none is given (where called with undefined)", async () => {
		const { tx, whereSpy } = mockTx([[]]);
		await listCasesForOwner(tx, "owner-1");
		expect(inArray).not.toHaveBeenCalled();
		expect(whereSpy).toHaveBeenCalledWith(undefined);
	});
});

describe("getCaseWithThread", () => {
	const caseId = "33333333-3333-4333-8333-333333333333";

	it("returns null when the case does not exist (no further queries)", async () => {
		const { tx, whereSpy } = mockTx([[]]);
		const result = await getCaseWithThread(tx, caseId);
		expect(result).toBeNull();
		// only the initial case select ran
		expect(whereSpy).toHaveBeenCalledTimes(1);
	});

	it("excludes is_internal staff notes and returns the case bundle", async () => {
		const caseRow = { id: caseId, subject: "S" };
		const messages = [{ id: "m-1", body: "hello" }];
		const attachments = [{ id: "a-1" }];
		const { tx } = mockTx([[caseRow], messages, attachments]);

		const result = await getCaseWithThread(tx, caseId);

		expect(result).not.toBeNull();
		expect(result?.case).toEqual(caseRow);
		expect(result?.messages).toEqual(messages);
		expect(result?.attachments).toEqual(attachments);

		// the message query filters is_internal = false
		const eqCalls = vi.mocked(eq).mock.calls;
		expect(
			eqCalls.some(
				(c) => c[0] === supportMessages.is_internal && c[1] === false,
			),
		).toBe(true);
	});
});
