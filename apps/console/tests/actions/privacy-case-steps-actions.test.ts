// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's case-handling actions (app/server/actions/privacy/cases.ts) now delegate to the
// shared steps (lib/privacy/case-steps.ts). What is pinned here is the ORDER the actions keep: a
// reason that the law requires is checked BEFORE standing is, so a caller with no reason learns
// nothing about the case; and standing over the case comes from its organization, as the deciding
// admin, whose user id is what the step records.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../privacy/scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));
const { authorizeInOrg, currentActor, authorize } = vi.hoisted(() => ({
	authorizeInOrg: vi.fn(),
	currentActor: vi.fn(),
	authorize: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorize: (...a: unknown[]) => authorize(...a),
	authorizeInOrg: (...a: unknown[]) => authorizeInOrg(...a),
	currentActor: () => currentActor(),
}));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: () => undefined }));

import {
	extendPrivacyCase,
	holdPrivacyCase,
	openPrivacyCase,
	refusePrivacyCase,
	verifyPrivacyCaseIdentity,
} from "@/app/server/actions/privacy/cases";
import { privacyCase, privacyCaseEvent } from "@/lib/db/schema";

const ADMIN = "99999999-9999-4999-8999-999999999999";
const TENANT = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const CASE = {
	id: "case-1",
	reference: "DSR-0000000F",
	organizationId: TENANT,
	subjectUserId: "u1",
	dueAt: new Date("2026-12-21T00:00:00.000Z"),
	extendedAt: null,
};

beforeEach(() => {
	sdb.calls.length = 0;
	vi.clearAllMocks();
	currentActor.mockResolvedValue({ userId: ADMIN, orgId: ADMIN });
	authorizeInOrg.mockResolvedValue({ userId: ADMIN, orgId: TENANT });
});

/** The actor id on every ledger event written. */
function eventActors(): unknown[] {
	return sdb.calls.filter((c) => c.table === privacyCaseEvent).map((c) => (c.values as { actorUserId: unknown }).actorUserId);
}

describe("the case-handling actions", () => {
	it("verify: proves standing in the case's org and records the admin", async () => {
		sdb.answer([CASE]);
		await verifyPrivacyCaseIdentity(CASE.reference, NOW);
		expect(authorizeInOrg).toHaveBeenCalledWith("edit", { type: "org", id: TENANT }, TENANT);
		expect(eventActors()).toEqual([ADMIN]);
	});

	it("extend, hold and refuse check the reason before reading the case", async () => {
		await expect(extendPrivacyCase(CASE.reference, "short", NOW)).rejects.toThrow(/must state why/);
		await expect(holdPrivacyCase(CASE.reference, "short", NOW)).rejects.toThrow(/state its basis/);
		await expect(refusePrivacyCase(CASE.reference, "short", NOW)).rejects.toThrow(/must state its grounds/);
		expect(sdb.calls).toEqual([]);
		expect(currentActor).not.toHaveBeenCalled();
	});

	it("extend, hold and refuse run the shared step once standing is proved", async () => {
		sdb.answer([CASE]);
		const { dueAt } = await extendPrivacyCase(CASE.reference, "Many systems to search", NOW);
		expect(dueAt).toEqual(new Date(CASE.dueAt.getTime() + 60 * 86_400_000));
		sdb.answer([CASE]);
		await holdPrivacyCase(CASE.reference, "Chargeback dispute open", NOW);
		sdb.answer([CASE]);
		await refusePrivacyCase(CASE.reference, "Manifestly unfounded; you may complain to the CPDP.", NOW);
		expect(sdb.calls.filter((c) => c.op === "update" && c.table === privacyCase)).toHaveLength(3);
		expect(eventActors()).toEqual([ADMIN, ADMIN, ADMIN]);
	});

	it("open: starts the clock for the caller's own request", async () => {
		currentActor.mockResolvedValue({ userId: "u1", orgId: "u1" });
		sdb.answer([{ id: "case-new" }]);
		const out = await openPrivacyCase({ kind: "access", email: "ada@example.io" }, NOW);
		expect(out.reference).toMatch(/^DSR-/);
		expect(sdb.calls.find((c) => c.op === "insert" && c.table === privacyCase)?.values).toMatchObject({
			kind: "access",
			subjectUserId: "u1",
			organizationId: null,
		});
	});
});
