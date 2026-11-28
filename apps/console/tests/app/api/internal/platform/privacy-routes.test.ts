// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The staff app's privacy routes (#7222). They act on any case in the deployment, including
// performing an erasure, so the assertions are about what is NOT reached: an unset secret or a wrong
// bearer reads no case and takes no step; no verified staff identity reads and writes nothing; a body
// that names its own actor is refused; a decided case takes no further step; the subject never
// decides their own request; a staff email with no account writes nothing. The acting staff member
// is the one the verified Access token names: the verifier is mocked here (lib/auth/staff-access.ts
// is tested against real tokens in tests/lib/auth/staff-access.test.ts), and every assertion about
// the actor checks it reached the step as the token's account. The steps themselves are the
// console's (lib/privacy/case-steps.ts) and are tested where they live.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => ({
	accountIdForEmail: vi.fn(),
	caseByReference: vi.fn(),
	caseEventsWithActors: vi.fn(),
	extendCase: vi.fn(),
	holdCase: vi.fn(),
	insertPrivacyCase: vi.fn(),
	markIdentityVerified: vi.fn(),
	performErasure: vi.fn(),
	queryControllerCaseList: vi.fn(),
	queryOverdueCases: vi.fn(),
	refuseCase: vi.fn(),
}));
/** The verified-staff-email seam: what the forwarded Access token names, after verification. */
const identity = vi.hoisted(() => ({ verifiedStaffEmail: vi.fn() }));
vi.mock("@/lib/auth/staff-access", () => identity);
/** The steps' refusal type, standing in for the real module's (hoisted with the mock). */
const { PrivacyStepRefusal } = vi.hoisted(() => ({
	PrivacyStepRefusal: class PrivacyStepRefusal extends Error {},
}));
vi.mock("@/lib/observability/log", () => ({ log: { error: vi.fn() } }));
vi.mock("@/lib/privacy/case-steps", async () => {
	const { z } = await import("zod");
	return {
		...steps,
		PrivacyStepRefusal,
		PRIVACY_CASE_KINDS: [
			"access",
			"export",
			"rectification",
			"erasure",
			"restriction",
			"objection",
			"portability",
		],
		referenceSchema: z.string().trim().regex(/^DSR-[0-9A-F]{8}$/),
	};
});

import { GET as getList, POST as openCase } from "@/app/api/internal/platform/privacy/cases/route";
import { GET as getCase } from "@/app/api/internal/platform/privacy/cases/[reference]/route";
import { POST as takeStep } from "@/app/api/internal/platform/privacy/cases/[reference]/[step]/route";
import { STEP_FAILED } from "@/app/api/internal/platform/privacy/shared";

const SECRET = "s3cret";
const STAFF = "99999999-9999-4999-8999-999999999999";
const STAFF_EMAIL = "staff@alethialabs.io";
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const SUBJECT_EMAIL = "former.user@example.com";

/** The accounts `accountIdForEmail` knows: the staff member's and the subject's. */
async function accountFor(email: string): Promise<string | null> {
	const e = email.trim().toLowerCase();
	if (e === STAFF_EMAIL) return STAFF;
	if (e === SUBJECT_EMAIL) return SUBJECT;
	return null;
}
const REF = "DSR-ABCD1234";

const original = process.env.PLATFORM_PROVISION_SECRET;
beforeEach(() => {
	process.env.PLATFORM_PROVISION_SECRET = SECRET;
	identity.verifiedStaffEmail.mockResolvedValue(STAFF_EMAIL);
	steps.accountIdForEmail.mockImplementation(accountFor);
	steps.caseByReference.mockResolvedValue(caseRow());
});
afterEach(() => {
	process.env.PLATFORM_PROVISION_SECRET = original;
	vi.clearAllMocks();
	vi.resetAllMocks();
});

/** A case row as `caseByReference` answers it. */
function caseRow(over: Record<string, unknown> = {}) {
	return {
		id: "case-1",
		reference: REF,
		kind: "erasure",
		state: "received",
		subjectUserId: SUBJECT,
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
		...over,
	};
}

/** A request with a JSON body and the given bearer. */
function req(path: string, body?: unknown, bearer: string | null = SECRET): Request {
	return new Request(`http://localhost/api/internal/platform/privacy${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** The route context for a case and step. */
function ctx(step: string, reference = REF) {
	return { params: Promise.resolve({ reference, step }) };
}

/** True when no step, read or write reached the case-steps module. */
function nothingReached(): boolean {
	return Object.values(steps).every((fn) => fn.mock.calls.length === 0);
}

describe("the operator-plane gate", () => {
	it("503s with the secret unset and 401s on a wrong or missing bearer, reaching nothing", async () => {
		steps.caseByReference.mockReset();
		delete process.env.PLATFORM_PROVISION_SECRET;
		expect((await getList(req("/cases", undefined, "x"))).status).toBe(503);

		process.env.PLATFORM_PROVISION_SECRET = SECRET;
		for (const bearer of ["wrong", null]) {
			expect((await getList(req("/cases", undefined, bearer))).status).toBe(401);
			expect((await openCase(req("/cases", {}, bearer))).status).toBe(401);
			expect(
				(await getCase(req(`/cases/${REF}`, undefined, bearer), { params: Promise.resolve({ reference: REF }) }))
					.status,
			).toBe(401);
			expect((await takeStep(req(`/cases/${REF}/fulfil-erasure`, {}, bearer), ctx("fulfil-erasure"))).status).toBe(401);
		}
		expect(nothingReached()).toBe(true);
		expect(identity.verifiedStaffEmail).not.toHaveBeenCalled();
	});
});

describe("the acting staff member", () => {
	it("401s every route when no staff identity verifies, reading and writing nothing", async () => {
		steps.caseByReference.mockReset();
		identity.verifiedStaffEmail.mockResolvedValue(null);
		expect((await getList(req("/cases"))).status).toBe(401);
		expect(
			(await openCase(req("/cases", { kind: "erasure", email: SUBJECT_EMAIL, receivedAt: "2026-11-20T00:00:00.000Z" })))
				.status,
		).toBe(401);
		expect(
			(await getCase(req(`/cases/${REF}`), { params: Promise.resolve({ reference: REF }) })).status,
		).toBe(401);
		const res = await takeStep(req(`/cases/${REF}/fulfil-erasure`, {}), ctx("fulfil-erasure"));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			error: "the staff member's Access token is missing or did not verify",
		});
		expect(nothingReached()).toBe(true);
	});

	it("verifies the identity from the request itself", async () => {
		steps.queryControllerCaseList.mockResolvedValue({ open: [], decided: [] });
		steps.queryOverdueCases.mockResolvedValue([]);
		const request = req("/cases");
		await getList(request);
		expect(identity.verifiedStaffEmail).toHaveBeenCalledWith(request);
	});

	it("refuses a body that names its own actor, even a real one, taking no step", async () => {
		steps.caseByReference.mockResolvedValue(caseRow({ identityVerifiedAt: new Date() }));
		const step = await takeStep(
			req(`/cases/${REF}/fulfil-erasure`, { actorUserId: STAFF }),
			ctx("fulfil-erasure"),
		);
		expect(step.status).toBe(400);
		expect(await step.json()).toEqual({
			error: "actorUserId is not accepted: the acting staff member is taken from the Access token",
		});
		const open = await openCase(
			req("/cases", {
				actorUserId: SUBJECT,
				kind: "erasure",
				email: SUBJECT_EMAIL,
				receivedAt: "2026-11-20T00:00:00.000Z",
			}),
		);
		expect(open.status).toBe(400);
		expect(steps.performErasure).not.toHaveBeenCalled();
		expect(steps.insertPrivacyCase).not.toHaveBeenCalled();
	});

	it("403s a verified staff email that has no account, before loading the case", async () => {
		identity.verifiedStaffEmail.mockResolvedValue("nobody@alethialabs.io");
		const res = await takeStep(req(`/cases/${REF}/verify`, {}), ctx("verify"));
		expect(res.status).toBe(403);
		expect(steps.caseByReference).not.toHaveBeenCalled();
		expect(steps.markIdentityVerified).not.toHaveBeenCalled();
	});
});

describe("POST /privacy/cases — record an emailed request", () => {
	const body = {
		kind: "erasure",
		email: "Former.User@Example.com",
		receivedAt: "2026-11-20T00:00:00.000Z",
	};

	it("opens a controller-level case linked to the matching account, as the token's staff member", async () => {
		steps.insertPrivacyCase.mockResolvedValue({ reference: REF });
		const res = await openCase(req("/cases", body));
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ reference: REF, linkedAccount: true });
		expect(steps.insertPrivacyCase).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "erasure",
				subjectUserId: SUBJECT,
				organizationId: null,
				receivedAt: new Date("2026-11-20T00:00:00.000Z"),
				actorUserId: STAFF,
			}),
		);
	});

	it("refuses a receipt time in the future, and a staff email with no account, opening nothing", async () => {
		const future = new Date(Date.now() + 86_400_000).toISOString();
		expect((await openCase(req("/cases", { ...body, receivedAt: future }))).status).toBe(400);

		identity.verifiedStaffEmail.mockResolvedValue("nobody@alethialabs.io");
		expect((await openCase(req("/cases", body))).status).toBe(403);
		expect(steps.insertPrivacyCase).not.toHaveBeenCalled();
	});

	it("refuses a malformed address", async () => {
		expect((await openCase(req("/cases", { ...body, email: "not-an-address" }))).status).toBe(400);
		expect(steps.insertPrivacyCase).not.toHaveBeenCalled();
	});
});

describe("POST /privacy/cases/<ref>/<step>", () => {
	it("runs the erasure as the staff member the token names", async () => {
		steps.caseByReference.mockResolvedValue(caseRow({ identityVerifiedAt: new Date() }));
		steps.performErasure.mockResolvedValue({ outcome: "paused_by_legal_hold", reason: "hold" });
		const res = await takeStep(
			req(`/cases/${REF}/fulfil-erasure`, {}),
			ctx("fulfil-erasure"),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ outcome: "paused_by_legal_hold", reason: "hold" });
		expect(steps.performErasure).toHaveBeenCalledWith(
			expect.objectContaining({ reference: REF }),
			STAFF,
			expect.any(Date),
		);
	});

	it("takes no further step on a decided case", async () => {
		steps.caseByReference.mockResolvedValue(
			caseRow({ state: "fulfilled", decidedAt: new Date() }),
		);
		for (const step of ["verify", "extend", "hold", "fulfil-erasure", "refuse"]) {
			const res = await takeStep(
				req(`/cases/${REF}/${step}`, { reason: "x".repeat(30) }),
				ctx(step),
			);
			expect(res.status).toBe(409);
		}
		expect(steps.performErasure).not.toHaveBeenCalled();
		expect(steps.refuseCase).not.toHaveBeenCalled();
		expect(steps.extendCase).not.toHaveBeenCalled();
	});

	it("never lets the subject decide their own request", async () => {
		identity.verifiedStaffEmail.mockResolvedValue(SUBJECT_EMAIL);
		const res = await takeStep(req(`/cases/${REF}/verify`, {}), ctx("verify"));
		expect(res.status).toBe(403);
		expect(steps.markIdentityVerified).not.toHaveBeenCalled();
	});

	it("answers an unknown step, a malformed reference and an unknown case without acting", async () => {
		expect(
			(await takeStep(req(`/cases/${REF}/delete`, {}), ctx("delete"))).status,
		).toBe(404);
		expect(
			(await takeStep(req("/cases/nope/verify", {}), ctx("verify", "nope")))
				.status,
		).toBe(400);
		steps.caseByReference.mockResolvedValue(null);
		expect(
			(await takeStep(req(`/cases/${REF}/verify`, {}), ctx("verify"))).status,
		).toBe(404);
		expect(steps.markIdentityVerified).not.toHaveBeenCalled();
	});

	it("refuses to verify twice, and carries a step's own refusal back as a 409", async () => {
		steps.caseByReference.mockResolvedValue(caseRow({ identityVerifiedAt: new Date() }));
		expect(
			(await takeStep(req(`/cases/${REF}/verify`, {}), ctx("verify"))).status,
		).toBe(409);
		expect(steps.markIdentityVerified).not.toHaveBeenCalled();

		steps.extendCase.mockRejectedValue(
			new PrivacyStepRefusal("only one extension is available."),
		);
		const res = await takeStep(
			req(`/cases/${REF}/extend`, { reason: "complex request" }),
			ctx("extend"),
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "only one extension is available." });
	});

	it("answers an unexpected failure with a generic sentence, never its own text", async () => {
		steps.caseByReference.mockResolvedValue(caseRow({ identityVerifiedAt: new Date() }));
		steps.performErasure.mockRejectedValue(
			new Error('relation "privacy_case" violates constraint at 10.0.0.5'),
		);
		const res = await takeStep(
			req(`/cases/${REF}/fulfil-erasure`, {}),
			ctx("fulfil-erasure"),
		);
		expect(res.status).toBe(409);
		const body: unknown = await res.json();
		expect(body).toEqual({ error: STEP_FAILED });
		expect(JSON.stringify(body)).not.toContain("10.0.0.5");
	});
});

describe("GET /privacy/cases", () => {
	it("asks for overdue cases across the whole deployment — no scope", async () => {
		steps.queryControllerCaseList.mockResolvedValue({ open: [], decided: [] });
		steps.queryOverdueCases.mockResolvedValue([
			{ reference: REF, kind: "erasure", state: "received", dueAt: new Date("2026-11-01T00:00:00.000Z") },
		]);
		const res = await getList(req("/cases"));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(steps.queryOverdueCases).toHaveBeenCalledWith(expect.any(Date), undefined);
		expect((await res.json()).overdue).toEqual([
			{ reference: REF, kind: "erasure", state: "received", dueAt: "2026-11-01T00:00:00.000Z" },
		]);
	});
});
