// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared handling steps of a privacy case (lib/privacy/case-steps.ts), as both the console and
// the staff queue run them.
//
// Pinned: a refusal, an extension and a hold each need a stated reason and write nothing without
// one; only one extension is available; a refusal closes the case and clears any schedule and link;
// a case opened from an email is linked to the account with that address when there is one, is NOT
// verified, and stores only the hash of the address.

import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { scriptedDb } from "./scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));

import { subjectHash } from "@/app/server/actions/privacy/ledger";
import { type PrivacyCase, privacyCase, privacyCaseEvent } from "@/lib/db/schema";
import {
	caseByReference,
	extendCase,
	holdCase,
	openCaseFromEmail,
	refuseCase,
	verifyCase,
} from "@/lib/privacy/case-steps";

const NOW = new Date("2026-11-21T10:00:00.000Z");
const ACTOR = "77777777-7777-7777-7777-777777777777";
const CASE = {
	id: "case-1",
	reference: "DSR-0000000C",
	dueAt: new Date("2026-12-21T00:00:00.000Z"),
	extendedAt: null,
} as unknown as PrivacyCase;

beforeEach(() => {
	sdb.calls.length = 0;
});

/** The kinds of the ledger events written. */
function eventKinds(): string[] {
	return sdb.calls.filter((c) => c.table === privacyCaseEvent).map((c) => (c.values as { kind: string }).kind);
}

describe("case steps", () => {
	it("finds a case by reference, and answers null for none", async () => {
		sdb.answer([CASE]);
		expect(await caseByReference("DSR-0000000C")).toBe(CASE);
		sdb.answer([]);
		expect(await caseByReference("DSR-0000000D")).toBeNull();
		await expect(caseByReference("not-a-reference")).rejects.toThrow();
	});

	it("verifies identity and moves the case into review", async () => {
		await verifyCase(CASE, ACTOR, NOW);
		expect(sdb.calls.find((c) => c.op === "update")?.set).toMatchObject({ identityVerifiedAt: NOW, state: "in_review" });
		expect(eventKinds()).toEqual(["identity_verified"]);
	});

	it("extends once, by two months, with the reason in the ledger", async () => {
		const { dueAt } = await extendCase(CASE, ACTOR, "Many systems to search", NOW);
		expect(dueAt).toEqual(new Date(CASE.dueAt.getTime() + 60 * 86_400_000));
		await expect(
			extendCase({ ...CASE, extendedAt: NOW }, ACTOR, "Many systems to search", NOW),
		).rejects.toThrow(/only one extension/);
		await expect(extendCase(CASE, ACTOR, "short", NOW)).rejects.toThrow(/must state why/);
		expect(sdb.calls.filter((c) => c.op === "update")).toHaveLength(1);
	});

	it("holds without refusing, and needs a basis", async () => {
		await holdCase(CASE, ACTOR, "Chargeback dispute open", NOW);
		expect(eventKinds()).toEqual(["legal_hold_applied"]);
		await expect(holdCase(CASE, ACTOR, "x", NOW)).rejects.toThrow(/state its basis/);
	});

	it("refuses with grounds, closing the case and clearing its schedule and link", async () => {
		await refuseCase(CASE, ACTOR, "Manifestly unfounded; you may complain to the CPDP.", NOW);
		expect(sdb.calls.find((c) => c.table === privacyCase && c.op === "update")?.set).toMatchObject({
			state: "refused",
			scheduledFor: null,
			linkTokenSha256: null,
			decidedByUserId: ACTOR,
		});
		await expect(refuseCase(CASE, ACTOR, "too short", NOW)).rejects.toThrow(/must state its grounds/);
	});

	it("opens a case from an email: hashed address, linked account, not verified", async () => {
		sdb.answer([{ id: "user-1" }], [{ id: "case-new" }]);
		const out = await openCaseFromEmail({ kind: "access", email: " Ada@Example.io " }, ACTOR, NOW);
		expect(out.subjectFound).toBe(true);
		const insert = sdb.calls.find((c) => c.op === "insert" && c.table === privacyCase);
		expect(insert?.values).toMatchObject({
			kind: "access",
			subjectUserId: "user-1",
			subjectEmailSha256: subjectHash("ada@example.io"),
		});
		expect(JSON.stringify(insert?.values)).not.toContain("ada@example.io");
	});

	it("opens a case for an address no account has", async () => {
		sdb.answer([], [{ id: "case-new" }]);
		const out = await openCaseFromEmail({ kind: "erasure", email: "nobody@example.io" }, ACTOR, NOW);
		expect(out.subjectFound).toBe(false);
		sdb.answer([], []);
		await expect(openCaseFromEmail({ kind: "erasure", email: "nobody@example.io" }, ACTOR, NOW)).rejects.toThrow(
			/Could not open/,
		);
	});
});
