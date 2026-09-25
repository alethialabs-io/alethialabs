// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Recording an acceptance (#2372).
//
// Three properties, each of which is a legal fact rather than a UI detail:
//
//   · the VERSION and HASH are snapshotted, so the record names text that can still be reproduced;
//   · the Privacy Policy is a NOTICE and can never be "accepted", because a stored acceptance of it
//     is the artefact a regulator reads as consent having been sought for something that does not
//     take consent;
//   · re-submitting is idempotent, because a double-click is not a second agreement.
//
// And a fourth (#5009): WHY an acceptance happened is decided by the server from the stored history,
// never taken from the browser — `signup` for a document the user has never accepted at any version,
// `reacceptance` otherwise — and the gate's copy is driven by the SAME answer.
//
// The database is an in-memory table the action's WHERE clauses are evaluated against (drizzle's
// `eq`/`and` are replaced by inspectable predicates), so each test states the HISTORY it starts from
// rather than the order in which the action happens to ask its questions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/billing/eligibility", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/billing/eligibility")>();
	return {
		acceptanceRequiredDocuments: vi.fn(actual.acceptanceRequiredDocuments),
		hasAcceptedCurrentDocuments: vi.fn(async () => false),
	};
});
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		eq: (column: unknown, value: unknown) => ({ op: "eq", column, value }),
		and: (...preds: unknown[]) => ({ op: "and", preds }),
	};
});

import { LEGAL_DOCUMENTS } from "@repo/legal/documents";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { legalAcceptance } from "@/lib/db/schema";
import { headers } from "next/headers";
import {
	acceptLegalDocuments,
	getPendingAcceptance,
} from "@/app/server/actions/legal";

const TERMS = LEGAL_DOCUMENTS.find((d) => d.id === "terms");
if (!TERMS) throw new Error("the terms document has been removed from @repo/legal");

/** One stored acceptance, reduced to the columns the action filters on. */
interface StoredRow {
	userId: string;
	documentId: string;
	documentVersion: string;
}

/** The schema columns the action's WHERE clauses may name, mapped onto a stored row's fields. */
const COLUMNS = new Map<unknown, keyof StoredRow>([
	[legalAcceptance.userId, "userId"],
	[legalAcceptance.documentId, "documentId"],
	[legalAcceptance.documentVersion, "documentVersion"],
]);

/** Evaluates a predicate built by the mocked `eq`/`and` against one stored row. */
function matches(pred: unknown, row: StoredRow): boolean {
	if (typeof pred !== "object" || pred === null || !("op" in pred)) {
		throw new Error("the action built a WHERE this stub cannot read");
	}
	if (pred.op === "and" && "preds" in pred && Array.isArray(pred.preds)) {
		return pred.preds.every((p: unknown) => matches(p, row));
	}
	if (pred.op === "eq" && "column" in pred && "value" in pred) {
		const key = COLUMNS.get(pred.column);
		if (!key) throw new Error("the action filtered on a column this stub does not model");
		return row[key] === pred.value;
	}
	throw new Error("the action built a WHERE this stub cannot read");
}

/**
 * A drizzle-shaped stub over an in-memory `legal_acceptance` table seeded with `rows`. Selects are
 * answered by evaluating the WHERE against the table; inserts are recorded AND appended, so a later
 * lookup in the same call sees them exactly as Postgres would.
 */
function stubDb(rows: StoredRow[]) {
	const table = [...rows];
	const inserts: Record<string, unknown>[] = [];
	let where: unknown = null;
	const chain = {
		select: () => chain,
		from: () => chain,
		where: (pred: unknown) => {
			where = pred;
			return chain;
		},
		limit: (n: number) =>
			Promise.resolve(
				table.filter((r) => matches(where, r)).slice(0, n).map(() => ({ id: "row" })),
			),
		insert: () => ({
			values: (v: StoredRow & Record<string, unknown>) => {
				inserts.push(v);
				table.push({
					userId: v.userId,
					documentId: v.documentId,
					documentVersion: v.documentVersion,
				});
				return Promise.resolve(undefined);
			},
		}),
	};
	vi.mocked(getServiceDb).mockReturnValue(
		chain as unknown as ReturnType<typeof getServiceDb>,
	);
	return inserts;
}

/** A row for this user's acceptance of the Terms at an OLDER version than the current one. */
const OLDER_TERMS: StoredRow = {
	userId: "u-1",
	documentId: "terms",
	documentVersion: `${TERMS.version}-previous`,
};

beforeEach(() => {
	vi.mocked(currentActor).mockResolvedValue({
		userId: "u-1",
		orgId: "org-1",
	} as unknown as Awaited<ReturnType<typeof currentActor>>);
	vi.mocked(headers).mockResolvedValue({
		get: (k: string) =>
			k === "x-forwarded-for" ? "203.0.113.9, 10.0.0.1" : k === "user-agent" ? "UA/1" : null,
	} as unknown as Awaited<ReturnType<typeof headers>>);
});
afterEach(() => vi.clearAllMocks());

describe("recording an acceptance", () => {
	it("snapshots the version and content hash, never just the id", async () => {
		const inserts = stubDb([]);
		await acceptLegalDocuments({
			documentIds: ["terms"],
			locale: "en",
			clientTimestamp: null,
		});
		expect(inserts).toHaveLength(1);
		expect(inserts[0]).toMatchObject({
			documentId: "terms",
			documentVersion: TERMS.version,
			documentHash: TERMS.contentHash,
			locale: "en",
		});
	});

	// Attribution, and no more than attribution. The proxy chain's FIRST hop is the client.
	it("records the submitting IP and user agent as evidence", async () => {
		const inserts = stubDb([]);
		await acceptLegalDocuments({
			documentIds: ["terms"],
			locale: "en",
			clientTimestamp: "2026-08-24T12:00:00.000Z",
		});
		expect(inserts[0].evidence).toEqual({
			ip: "203.0.113.9",
			userAgent: "UA/1",
			clientTimestamp: "2026-08-24T12:00:00.000Z",
			// Set by the server: the console gate is this action's only surface.
			surface: "console-gate",
		});
	});

	// THE property that keeps the privacy basis honest. The Privacy Policy is presented as a notice;
	// recording an "acceptance" of it would misstate its basis, and it is exactly what a well-meaning
	// caller passing every document id would produce.
	it("refuses to record an acceptance of a notice-only document", async () => {
		stubDb([]);
		await expect(
			acceptLegalDocuments({
				documentIds: ["privacy"],
				locale: "en",
				clientTimestamp: null,
			}),
		).rejects.toThrow(/No acceptance-required document/);
	});

	it("silently ignores notice-only ids alongside a real one", async () => {
		const inserts = stubDb([]);
		await acceptLegalDocuments({
			documentIds: ["terms", "privacy", "cookies"],
			locale: "en",
			clientTimestamp: null,
		});
		expect(inserts.map((i) => i.documentId)).toEqual(["terms"]);
	});

	it("ignores a document id this product does not publish", async () => {
		stubDb([]);
		await expect(
			acceptLegalDocuments({
				documentIds: ["not-a-document"],
				locale: "en",
				clientTimestamp: null,
			}),
		).rejects.toThrow(/No acceptance-required document/);
	});

	// A double-click is not a second agreement.
	it("is idempotent for the same user, document and version", async () => {
		const inserts = stubDb([{ userId: "u-1", documentId: "terms", documentVersion: TERMS.version }]);
		const { accepted } = await acceptLegalDocuments({
			documentIds: ["terms"],
			locale: "en",
			clientTimestamp: null,
		});
		expect(accepted).toBe(0);
		expect(inserts).toHaveLength(0);
	});

	// Null, not a placeholder: in a record whose job is attribution, an absent value must never read
	// as a real one.
	it("records a stripped IP as null rather than an empty string", async () => {
		vi.mocked(headers).mockResolvedValue({
			get: () => null,
		} as unknown as Awaited<ReturnType<typeof headers>>);
		const inserts = stubDb([]);
		await acceptLegalDocuments({
			documentIds: ["terms"],
			locale: "en",
			clientTimestamp: null,
		});
		expect(inserts[0].evidence).toMatchObject({ ip: null, userAgent: null });
	});
});

describe("the context of an acceptance is the server's to decide (#5009)", () => {
	it("records a document the user has never accepted at any version as `signup`", async () => {
		const inserts = stubDb([]);
		await acceptLegalDocuments({ documentIds: ["terms"], clientTimestamp: null });
		expect(inserts).toHaveLength(1);
		expect(inserts[0].context).toBe("signup");
	});

	it("records a new version of a document accepted before as `reacceptance`", async () => {
		const inserts = stubDb([OLDER_TERMS]);
		await acceptLegalDocuments({ documentIds: ["terms"], clientTimestamp: null });
		expect(inserts).toHaveLength(1);
		expect(inserts[0]).toMatchObject({
			documentVersion: TERMS.version,
			context: "reacceptance",
		});
	});

	// Another user's history is not this user's. Without the user filter, one earlier signup anywhere
	// would turn every later first acceptance into a "reacceptance".
	it("does not count another user's acceptance as this user's history", async () => {
		const inserts = stubDb([{ ...OLDER_TERMS, userId: "someone-else" }]);
		await acceptLegalDocuments({ documentIds: ["terms"], clientTimestamp: null });
		expect(inserts[0].context).toBe("signup");
	});

	// The browser has no say. A request that still carries `context` or `surface` is refused
	// outright — nothing is written — rather than having the key dropped and the call succeed.
	it.each([
		["context", { context: "paid_conversion" }],
		["surface", { surface: "checkout" }],
	])("rejects a client-sent %s and writes nothing", async (_key, extra) => {
		const inserts = stubDb([]);
		const forged = { documentIds: ["terms"], clientTimestamp: null, ...extra };
		await expect(acceptLegalDocuments(forged)).rejects.toThrow(/unrecognized/i);
		expect(inserts).toHaveLength(0);
	});
});

describe("the gate's first-acceptance flag", () => {
	it("marks a document the user has never accepted as a first acceptance", async () => {
		stubDb([]);
		const pending = await getPendingAcceptance();
		const terms = pending.documents.find((d) => d.id === "terms");
		expect(terms).toMatchObject({ version: TERMS.version, firstAcceptance: true });
	});

	it("marks a document accepted at an older version as NOT a first acceptance", async () => {
		stubDb([OLDER_TERMS]);
		const pending = await getPendingAcceptance();
		const terms = pending.documents.find((d) => d.id === "terms");
		expect(terms).toMatchObject({ firstAcceptance: false });
	});

	// The flag and the recorded context are one answer, not two: for each history, the copy the gate
	// shows and the context the acceptance is then stored under must agree.
	it.each([
		["no history", [], "signup"],
		["an older version", [OLDER_TERMS], "reacceptance"],
	])("agrees with the recorded context (%s)", async (_label, history, expected) => {
		stubDb(history);
		const pending = await getPendingAcceptance();
		const flag = pending.documents.find((d) => d.id === "terms")?.firstAcceptance;
		const inserts = stubDb(history);
		await acceptLegalDocuments({ documentIds: ["terms"], clientTimestamp: null });
		expect(inserts[0].context).toBe(expected);
		expect(flag).toBe(expected === "signup");
	});
});
