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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/billing/eligibility", () => ({
	acceptanceRequiredDocuments: vi.fn(),
	hasAcceptedCurrentDocuments: vi.fn(async () => false),
}));

import { LEGAL_DOCUMENTS } from "@repo/legal/documents";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { headers } from "next/headers";
import { acceptLegalDocuments } from "@/app/server/actions/legal";

const TERMS = LEGAL_DOCUMENTS.find((d) => d.id === "terms");
if (!TERMS) throw new Error("the terms document has been removed from @repo/legal");

/** A drizzle-shaped stub: `existing` is what the duplicate lookup finds; inserts are recorded. */
function stubDb(existing: unknown[]) {
	const inserts: Record<string, unknown>[] = [];
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(existing),
		insert: () => ({
			values: (v: Record<string, unknown>) => {
				inserts.push(v);
				return Promise.resolve(undefined);
			},
		}),
	};
	vi.mocked(getServiceDb).mockReturnValue(
		chain as unknown as ReturnType<typeof getServiceDb>,
	);
	return inserts;
}

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
afterEach(() => vi.resetAllMocks());

describe("recording an acceptance", () => {
	it("snapshots the version and content hash, never just the id", async () => {
		const inserts = stubDb([]);
		await acceptLegalDocuments({
			documentIds: ["terms"],
			locale: "en",
			surface: "console-gate",
			context: "signup",
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
			surface: "checkout",
			context: "paid_conversion",
			clientTimestamp: "2026-08-24T12:00:00.000Z",
		});
		expect(inserts[0].evidence).toEqual({
			ip: "203.0.113.9",
			userAgent: "UA/1",
			clientTimestamp: "2026-08-24T12:00:00.000Z",
			surface: "checkout",
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
				surface: "signup",
				context: "signup",
				clientTimestamp: null,
			}),
		).rejects.toThrow(/No acceptance-required document/);
	});

	it("silently ignores notice-only ids alongside a real one", async () => {
		const inserts = stubDb([]);
		await acceptLegalDocuments({
			documentIds: ["terms", "privacy", "cookies"],
			locale: "en",
			surface: "signup",
			context: "signup",
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
				surface: "signup",
				context: "signup",
				clientTimestamp: null,
			}),
		).rejects.toThrow(/No acceptance-required document/);
	});

	// A double-click is not a second agreement.
	it("is idempotent for the same user, document and version", async () => {
		const inserts = stubDb([{ id: "already-there" }]);
		const { accepted } = await acceptLegalDocuments({
			documentIds: ["terms"],
			locale: "en",
			surface: "console-gate",
			context: "reacceptance",
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
			surface: "signup",
			context: "signup",
			clientTimestamp: null,
		});
		expect(inserts[0].evidence).toMatchObject({ ip: null, userAgent: null });
	});
});
