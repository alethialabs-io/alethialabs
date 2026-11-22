// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff privacy queue's decisions as the console carries them out (lib/privacy/staff-queue.ts),
// and the platform route that admits them (app/api/internal/platform/privacy).
//
// Pinned: the route refuses without its bearer secret and with a malformed body; each decision runs
// the shared step under the STAFF member's user id; the steps' own refusals (no reason, not
// verified, a kind fulfilled by hand) come back as messages for the operator rather than as faults;
// an erasure goes through `performErasure`, and an export reaches the account's own address.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));
const { performErasure, deliverExport, authorized } = vi.hoisted(() => ({
	performErasure: vi.fn(),
	deliverExport: vi.fn(),
	authorized: vi.fn(),
}));
vi.mock("@/lib/privacy/erasure", () => ({ performErasure: (...a: unknown[]) => performErasure(...a) }));
vi.mock("@/lib/privacy/export", () => ({ deliverExport: (...a: unknown[]) => deliverExport(...a) }));
vi.mock("@/lib/auth/internal-auth", () => ({ isPlatformProvisionAuthorized: () => authorized() }));

import { POST } from "@/app/api/internal/platform/privacy/route";
import { privacyCase, privacyCaseEvent } from "@/lib/db/schema";
import { runStaffPrivacyAction } from "@/lib/privacy/staff-queue";

const STAFF = "55555555-5555-5555-5555-555555555555";
const NOW = new Date("2026-11-21T10:00:00.000Z");
const CASE = {
	id: "case-1",
	reference: "DSR-0000000A",
	kind: "erasure",
	state: "in_review",
	subjectUserId: "66666666-6666-6666-6666-666666666666",
	subjectEmailSha256: "a".repeat(64),
	identityVerifiedAt: NOW,
	extendedAt: null,
	dueAt: new Date("2026-12-21T00:00:00.000Z"),
	legalHoldReason: null,
};

beforeEach(() => {
	sdb.calls.length = 0;
	performErasure.mockReset();
	deliverExport.mockReset();
	authorized.mockReset();
	process.env.PLATFORM_PROVISION_SECRET = "secret";
});

describe("runStaffPrivacyAction", () => {
	it("verifies identity under the staff member's own user id", async () => {
		sdb.answer([{ ...CASE, identityVerifiedAt: null }]);
		const out = await runStaffPrivacyAction({ action: "verify", reference: CASE.reference, staffUserId: STAFF }, NOW);
		expect(out).toEqual({ ok: true, message: "Identity verified." });
		const event = sdb.calls.find((c) => c.table === privacyCaseEvent);
		expect(event?.values).toMatchObject({ kind: "identity_verified", actorUserId: STAFF });
	});

	it("answers a refusal without grounds as a message, and records nothing", async () => {
		sdb.answer([CASE]);
		const out = await runStaffPrivacyAction(
			{ action: "refuse", reference: CASE.reference, reason: "too short", staffUserId: STAFF },
			NOW,
		);
		expect(out.ok).toBe(false);
		expect(out.message).toMatch(/must state its grounds/);
		expect(sdb.calls.filter((c) => c.op !== "select")).toEqual([]);
	});

	it("fulfils an erasure through performErasure, as the staff member", async () => {
		sdb.answer([CASE]);
		performErasure.mockResolvedValue({ outcome: "erased", tables: [], rowsErased: 4, rowsPseudonymized: 2, tablesRetained: 3 });
		const out = await runStaffPrivacyAction({ action: "fulfil", reference: CASE.reference, staffUserId: STAFF }, NOW);
		expect(performErasure).toHaveBeenCalledWith(CASE, STAFF, NOW);
		expect(out).toEqual({ ok: true, message: expect.stringContaining("4 row(s) deleted") });
	});

	it("passes the live-resources refusal through to the operator", async () => {
		sdb.answer([CASE]);
		performErasure.mockResolvedValue({ outcome: "refused_live_resources", message: "Erasure is not performed while…", residency: {} });
		const out = await runStaffPrivacyAction({ action: "fulfil", reference: CASE.reference, staffUserId: STAFF }, NOW);
		expect(out).toEqual({ ok: false, message: "Erasure is not performed while…" });
	});

	it("sends an export to the account's own address, and refuses an unverified one", async () => {
		sdb.answer([{ ...CASE, kind: "access" }], [{ email: "ada@example.io" }]);
		deliverExport.mockResolvedValue({ expiresAt: new Date("2026-11-24T10:00:00.000Z") });
		const out = await runStaffPrivacyAction({ action: "fulfil", reference: CASE.reference, staffUserId: STAFF }, NOW);
		expect(out.ok).toBe(true);
		expect(deliverExport.mock.calls[0]?.[1]).toEqual({ userId: CASE.subjectUserId, email: "ada@example.io" });

		sdb.answer([{ ...CASE, kind: "portability", identityVerifiedAt: null }]);
		const unverified = await runStaffPrivacyAction({ action: "fulfil", reference: CASE.reference, staffUserId: STAFF }, NOW);
		expect(unverified).toEqual({ ok: false, message: expect.stringMatching(/not verified/) });
	});

	it("leaves a kind that is fulfilled by hand to a person", async () => {
		sdb.answer([{ ...CASE, kind: "rectification" }]);
		const out = await runStaffPrivacyAction({ action: "fulfil", reference: CASE.reference, staffUserId: STAFF }, NOW);
		expect(out.ok).toBe(false);
		expect(performErasure).not.toHaveBeenCalled();
		expect(deliverExport).not.toHaveBeenCalled();
	});

	it("opens a case from an email, linked to the account with that address, unverified", async () => {
		sdb.answer([{ id: CASE.subjectUserId }], [{ id: "case-new" }]);
		const out = await runStaffPrivacyAction(
			{ action: "open", kind: "erasure", email: "Ada@Example.io", staffUserId: STAFF },
			NOW,
		);
		expect(out.ok).toBe(true);
		const insert = sdb.calls.find((c) => c.op === "insert" && c.table === privacyCase);
		expect(insert?.values).toMatchObject({ kind: "erasure", subjectUserId: CASE.subjectUserId, organizationId: null });
		expect(insert?.values).not.toHaveProperty("identityVerifiedAt");
	});
});

describe("POST /api/internal/platform/privacy", () => {
	/** A request with a JSON body. */
	function req(body: unknown): Request {
		return new Request("https://console.example.io/api/internal/platform/privacy", {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	it("refuses a caller without the provisioning bearer", async () => {
		authorized.mockReturnValue(false);
		const res = await POST(req({ action: "verify", reference: CASE.reference, staffUserId: STAFF }));
		expect(res.status).toBe(401);
		expect(sdb.calls).toEqual([]);
	});

	it("refuses a malformed decision before any query", async () => {
		authorized.mockReturnValue(true);
		const res = await POST(req({ action: "fulfil", reference: "DSR-nope", staffUserId: STAFF }));
		expect(res.status).toBe(400);
		expect(sdb.calls).toEqual([]);
	});

	it("fails closed when the secret is not configured", async () => {
		delete process.env.PLATFORM_PROVISION_SECRET;
		authorized.mockReturnValue(true);
		const res = await POST(req({ action: "verify", reference: CASE.reference, staffUserId: STAFF }));
		expect(res.status).toBe(503);
	});
});
