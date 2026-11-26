// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The staff app's privacy routes (#7222). They act on any case in the deployment, including
// performing an erasure, so the assertions are about what is NOT reached: an unset secret or a wrong
// bearer reads no case and takes no step; a decided case takes no further step; the subject never
// decides their own request; an actor id that names no account writes nothing. The steps themselves
// are the console's (lib/privacy/case-steps.ts) and are tested where they live.

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
	userExists: vi.fn(),
}));
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
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const REF = "DSR-ABCD1234";

const original = process.env.PLATFORM_PROVISION_SECRET;
beforeEach(() => {
	process.env.PLATFORM_PROVISION_SECRET = SECRET;
	steps.userExists.mockResolvedValue(true);
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
		steps.userExists.mockReset();
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
			expect((await takeStep(req(`/cases/${REF}/fulfil-erasure`, { actorUserId: STAFF }, bearer), ctx("fulfil-erasure"))).status).toBe(401);
		}
		expect(nothingReached()).toBe(true);
	});
});

describe("POST /privacy/cases — record an emailed request", () => {
	const body = {
		actorUserId: STAFF,
		kind: "erasure",
		email: "Former.User@Example.com",
		receivedAt: "2026-11-20T00:00:00.000Z",
	};

	it("opens a controller-level case linked to the matching account, its clock at receipt", async () => {
		steps.accountIdForEmail.mockResolvedValue(SUBJECT);
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

	it("refuses a receipt time in the future, and an actor with no account, opening nothing", async () => {
		const future = new Date(Date.now() + 86_400_000).toISOString();
		expect((await openCase(req("/cases", { ...body, receivedAt: future }))).status).toBe(400);

		steps.userExists.mockResolvedValue(false);
		expect((await openCase(req("/cases", body))).status).toBe(400);
		expect(steps.insertPrivacyCase).not.toHaveBeenCalled();
	});

	it("refuses a malformed address", async () => {
		expect((await openCase(req("/cases", { ...body, email: "not-an-address" }))).status).toBe(400);
		expect(steps.insertPrivacyCase).not.toHaveBeenCalled();
	});
});

describe("POST /privacy/cases/<ref>/<step>", () => {
	it("runs the erasure as the acting staff member", async () => {
		steps.caseByReference.mockResolvedValue(caseRow({ identityVerifiedAt: new Date() }));
		steps.performErasure.mockResolvedValue({ outcome: "paused_by_legal_hold", reason: "hold" });
		const res = await takeStep(
			req(`/cases/${REF}/fulfil-erasure`, { actorUserId: STAFF }),
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
				req(`/cases/${REF}/${step}`, { actorUserId: STAFF, reason: "x".repeat(30) }),
				ctx(step),
			);
			expect(res.status).toBe(409);
		}
		expect(steps.performErasure).not.toHaveBeenCalled();
		expect(steps.refuseCase).not.toHaveBeenCalled();
		expect(steps.extendCase).not.toHaveBeenCalled();
	});

	it("never lets the subject decide their own request", async () => {
		const res = await takeStep(
			req(`/cases/${REF}/verify`, { actorUserId: SUBJECT }),
			ctx("verify"),
		);
		expect(res.status).toBe(403);
		expect(steps.markIdentityVerified).not.toHaveBeenCalled();
	});

	it("refuses an actor with no account before loading the case", async () => {
		steps.userExists.mockResolvedValue(false);
		const res = await takeStep(req(`/cases/${REF}/verify`, { actorUserId: STAFF }), ctx("verify"));
		expect(res.status).toBe(400);
		expect(steps.caseByReference).not.toHaveBeenCalled();
	});

	it("answers an unknown step, a malformed reference and an unknown case without acting", async () => {
		expect(
			(await takeStep(req(`/cases/${REF}/delete`, { actorUserId: STAFF }), ctx("delete"))).status,
		).toBe(404);
		expect(
			(await takeStep(req("/cases/nope/verify", { actorUserId: STAFF }), ctx("verify", "nope")))
				.status,
		).toBe(400);
		steps.caseByReference.mockResolvedValue(null);
		expect(
			(await takeStep(req(`/cases/${REF}/verify`, { actorUserId: STAFF }), ctx("verify"))).status,
		).toBe(404);
		expect(steps.markIdentityVerified).not.toHaveBeenCalled();
	});

	it("refuses to verify twice, and carries a step's own refusal back as a 409", async () => {
		steps.caseByReference.mockResolvedValue(caseRow({ identityVerifiedAt: new Date() }));
		expect(
			(await takeStep(req(`/cases/${REF}/verify`, { actorUserId: STAFF }), ctx("verify"))).status,
		).toBe(409);
		expect(steps.markIdentityVerified).not.toHaveBeenCalled();

		steps.extendCase.mockRejectedValue(
			new PrivacyStepRefusal("only one extension is available."),
		);
		const res = await takeStep(
			req(`/cases/${REF}/extend`, { actorUserId: STAFF, reason: "complex request" }),
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
			req(`/cases/${REF}/fulfil-erasure`, { actorUserId: STAFF }),
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
