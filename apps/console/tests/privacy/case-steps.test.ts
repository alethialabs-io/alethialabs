// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The privacy handling steps without their authorization (lib/privacy/case-steps.ts, #7222). Each
// assertion is about what reached the database: the row a case is opened with, the update a step
// makes, and the ledger line it appends. The erasure itself is held to account in
// tests/actions/privacy-erasure-fulfilment.test.ts; the callers' authorization in
// tests/actions/privacy-case-readers.test.ts and tests/app/api/internal/platform/privacy-routes.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** One write that reached the fake database. */
interface Write {
	op: "insert" | "update";
	table: unknown;
	values: unknown;
}

const writes: Write[] = [];
/** What each successive read answers, in order. */
let reads: unknown[][] = [];
/** What an insert's `returning()` answers. Empty simulates an insert that returned no row. */
let returned: unknown[] = [{ id: "case-1" }];

/** A thenable drizzle chain: every builder method returns it, and awaiting it answers `rows`. */
function chain(rows: () => unknown[]) {
	const c: Record<string, unknown> = {};
	for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "returning"]) {
		c[m] = () => c;
	}
	c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
		Promise.resolve(rows()).then(resolve, reject);
	return c;
}

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => chain(() => reads.shift() ?? []),
		insert: (table: unknown) => ({
			values: (values: unknown) => {
				writes.push({ op: "insert", table, values });
				return chain(() => returned);
			},
		}),
		update: (table: unknown) => ({
			set: (values: unknown) => {
				writes.push({ op: "update", table, values });
				return chain(() => []);
			},
		}),
	}),
}));

import {
	accountIdForEmail,
	assertExtensionReason,
	assertHoldReason,
	assertRefusalReason,
	caseByReference,
	caseEvents,
	caseEventsWithActors,
	extendCase,
	holdCase,
	insertPrivacyCase,
	markIdentityVerified,
	type PrivacyCaseRow,
	queryControllerCaseList,
	queryOverdueCases,
	refuseCase,
	userExists,
} from "@/lib/privacy/case-steps";
import { privacyCase, privacyCaseEvent } from "@/lib/db/schema";

const STAFF = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-11-26T10:00:00.000Z");
const DAY = 86_400_000;

/** A case row, as `caseByReference` answers it — every column, so no cast is needed. */
function row(over: Partial<PrivacyCaseRow> = {}): PrivacyCaseRow {
	return {
		id: "case-1",
		reference: "DSR-ABCD1234",
		kind: "erasure",
		state: "received",
		subjectUserId: null,
		subjectEmailSha256: "hash",
		organizationId: null,
		receivedAt: new Date("2026-11-01T00:00:00.000Z"),
		dueAt: new Date("2026-12-01T00:00:00.000Z"),
		extendedAt: null,
		extensionReason: null,
		identityVerifiedAt: null,
		legalHoldReason: null,
		decidedAt: null,
		decidedByUserId: null,
		refusalReason: null,
		scope: null,
		exportObjectKey: null,
		exportManifest: null,
		exportExpiresAt: null,
		createdAt: new Date("2026-11-01T00:00:00.000Z"),
		updatedAt: new Date("2026-11-01T00:00:00.000Z"),
		...over,
	};
}

/** The ledger lines appended, as their summaries. */
function ledger(): string[] {
	return writes
		.filter((w) => w.op === "insert" && w.table === privacyCaseEvent)
		.map((w) => {
			const v = w.values;
			if (typeof v !== "object" || v === null || !("detail" in v)) return "";
			const d = v.detail;
			return typeof d === "object" && d !== null && "summary" in d ? String(d.summary) : "";
		});
}

/** The update made to the case row. */
function caseUpdate(): unknown {
	return writes.find((w) => w.op === "update" && w.table === privacyCase)?.values;
}

beforeEach(() => {
	writes.length = 0;
	reads = [];
	returned = [{ id: "case-1" }];
});

describe("the reason rules", () => {
	it("refuse reasons shorter than the law needs, and accept ones long enough", () => {
		expect(() => assertExtensionReason("short")).toThrow(/why the request is complex/);
		expect(() => assertHoldReason("   short   ")).toThrow(/state its basis/);
		expect(() => assertRefusalReason("not enough here")).toThrow(/state its grounds/);
		expect(() => assertExtensionReason("a complex, multi-system request")).not.toThrow();
		expect(() => assertHoldReason("litigation hold, case 12")).not.toThrow();
		expect(() => assertRefusalReason("manifestly unfounded; you may complain to the CPDP")).not.toThrow();
	});
});

describe("insertPrivacyCase", () => {
	it("stores the hashed address and a deadline 30 days from RECEIPT, and logs how it arrived", async () => {
		const receivedAt = new Date("2026-11-20T00:00:00.000Z");
		const { reference } = await insertPrivacyCase({
			kind: "erasure",
			email: "  Someone@Example.com ",
			subjectUserId: null,
			organizationId: null,
			receivedAt,
			receivedHow: "Request received by email and recorded by staff",
			actorUserId: STAFF,
		});
		expect(reference).toMatch(/^DSR-[0-9A-F]{8}$/);
		const inserted = writes.find((w) => w.table === privacyCase)?.values;
		expect(inserted).toMatchObject({
			kind: "erasure",
			subjectUserId: null,
			organizationId: null,
			receivedAt,
			dueAt: new Date(receivedAt.getTime() + 30 * DAY),
		});
		// Never the address in the clear.
		expect(JSON.stringify(inserted)).not.toContain("example.com");
		expect(JSON.stringify(inserted)).not.toContain("Example.com");
		expect(ledger()).toEqual([
			"Request received by email and recorded by staff (erasure). Response due within 30 days.",
		]);
	});
});

describe("insertPrivacyCase when the insert returns no row", () => {
	it("throws, and appends no ledger line for a case that does not exist", async () => {
		returned = [];
		await expect(
			insertPrivacyCase({
				kind: "access",
				email: "a@b.co",
				subjectUserId: null,
				organizationId: null,
				receivedAt: NOW,
				receivedHow: "Request received",
				actorUserId: STAFF,
			}),
		).rejects.toThrow(/Could not open/);
		expect(ledger()).toEqual([]);
	});
});

describe("lookups", () => {
	it("accountIdForEmail answers the matching account, or null", async () => {
		reads = [[{ id: "user-1" }], []];
		expect(await accountIdForEmail("a@b.co")).toBe("user-1");
		expect(await accountIdForEmail("nobody@b.co")).toBeNull();
	});

	it("userExists answers whether the id names an account", async () => {
		reads = [[{ id: STAFF }], []];
		expect(await userExists(STAFF)).toBe(true);
		expect(await userExists(STAFF)).toBe(false);
	});

	it("caseByReference answers the row or null, and throws on a malformed reference", async () => {
		reads = [[row()], []];
		expect((await caseByReference("DSR-ABCD1234"))?.id).toBe("case-1");
		expect(await caseByReference("DSR-ABCD1234")).toBeNull();
		await expect(caseByReference("nope")).rejects.toThrow();
	});

	it("the list, overdue and ledger readers answer what the database returns", async () => {
		reads = [[row()], [], [{ reference: "DSR-ABCD1234" }], [{ kind: "received" }], [{ kind: "note" }]];
		expect(await queryControllerCaseList()).toEqual({ open: [row()], decided: [] });
		expect(await queryOverdueCases(NOW, undefined)).toEqual([{ reference: "DSR-ABCD1234" }]);
		expect(await caseEvents(row())).toEqual([{ kind: "received" }]);
		expect(await caseEventsWithActors(row())).toEqual([{ kind: "note" }]);
	});
});

describe("the steps", () => {
	it("markIdentityVerified moves the case to review and records it", async () => {
		await markIdentityVerified(row(), STAFF, NOW);
		expect(caseUpdate()).toEqual({ identityVerifiedAt: NOW, state: "in_review", updatedAt: NOW });
		expect(ledger()).toEqual(["Identity verified; the request may now be acted on."]);
	});

	it("extendCase adds 60 days to the STORED deadline, once", async () => {
		const { dueAt } = await extendCase(row(), STAFF, "  a complex, multi-system request  ", NOW);
		expect(dueAt).toEqual(new Date(new Date("2026-12-01T00:00:00.000Z").getTime() + 60 * DAY));
		expect(caseUpdate()).toMatchObject({
			dueAt,
			extendedAt: NOW,
			extensionReason: "a complex, multi-system request",
		});
		expect(ledger()).toEqual([
			"Response period extended to 2027-01-30: a complex, multi-system request",
		]);

		writes.length = 0;
		await expect(
			extendCase(row({ extendedAt: NOW }), STAFF, "a complex, multi-system request", NOW),
		).rejects.toThrow(/already been extended/);
		await expect(extendCase(row(), STAFF, "short", NOW)).rejects.toThrow(/complex/);
		expect(writes).toEqual([]);
	});

	it("holdCase records the basis and pauses, never refuses", async () => {
		await holdCase(row(), STAFF, "litigation hold, case 12", NOW);
		expect(caseUpdate()).toEqual({ legalHoldReason: "litigation hold, case 12", updatedAt: NOW });
		expect(ledger()[0]).toMatch(/paused, not refused/);
		expect(JSON.stringify(caseUpdate())).not.toContain("refused");
	});

	it("refuseCase closes the case with its grounds and the deciding actor", async () => {
		const grounds = "manifestly unfounded; you may complain to the CPDP";
		await refuseCase(row(), STAFF, grounds, NOW);
		expect(caseUpdate()).toEqual({
			state: "refused",
			refusalReason: grounds,
			decidedAt: NOW,
			decidedByUserId: STAFF,
			updatedAt: NOW,
		});
		expect(ledger()).toEqual([`Refused: ${grounds}`]);

		writes.length = 0;
		await expect(refuseCase(row(), STAFF, "too short", NOW)).rejects.toThrow(/grounds/);
		expect(writes).toEqual([]);
	});
});
