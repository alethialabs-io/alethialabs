// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/approvals/:id/decision: only a console browser session decides. A bearer of any kind is
// refused 403 before the session or the approval is read; a request with no session is 401; a
// session whose resolved actor is not that session's own `session` credential is 403.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, currentActor, decideApproval, withActorScope } = vi.hoisted(() => ({
	getSession: vi.fn(),
	currentActor: vi.fn(),
	decideApproval: vi.fn(),
	withActorScope: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/authz/guard", () => ({ currentActor }));
vi.mock("@/lib/approvals/decide", () => ({ decideApproval }));
vi.mock("@/lib/db", () => ({ withActorScope }));

import { POST } from "@/app/api/approvals/[id]/decision/route";

const ID = "00000000-0000-4000-8000-000000000050";
const USER = "00000000-0000-4000-8000-000000000001";
const params = { params: Promise.resolve({ id: ID }) };

/** A decision request, with `authorization` set when given. */
function request(authorization?: string): Request {
	return new Request(`http://console.test/api/approvals/${ID}/decision`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
		body: JSON.stringify({ decision: "approve" }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getSession.mockResolvedValue({ user: { id: USER }, session: { id: "s1", createdAt: new Date() } });
	currentActor.mockResolvedValue({ userId: USER, orgId: USER, credential: "session" });
});

describe("POST /api/approvals/:id/decision", () => {
	it.each(["Bearer alethia_sat_abc", "Bearer eyJhbGciOi.cli.login", "Bearer mcp-oauth-token"])(
		"refuses a bearer (%s) with 403 before reading the session",
		async (authorization) => {
			const res = await POST(request(authorization), params);
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ code: "not_a_person" });
			expect(getSession).not.toHaveBeenCalled();
			expect(decideApproval).not.toHaveBeenCalled();
		},
	);

	it("answers 401 with no session", async () => {
		getSession.mockResolvedValue(null);
		expect((await POST(request(), params)).status).toBe(401);
		expect(decideApproval).not.toHaveBeenCalled();
	});

	it("refuses an actor that is not the session's own person as a session credential", async () => {
		currentActor.mockResolvedValue({ userId: USER, orgId: USER, credential: "agent_in_app" });
		expect((await POST(request(), params)).status).toBe(403);
		currentActor.mockResolvedValue({ userId: "someone-else", orgId: USER, credential: "session" });
		expect((await POST(request(), params)).status).toBe(403);
		expect(decideApproval).not.toHaveBeenCalled();
	});

	it("hands a signed-in person's decision to the engine with the session it was made in", async () => {
		withActorScope.mockImplementation(async (_actor: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}));
		decideApproval.mockResolvedValue({ ok: false, error: { message: "expired", code: "not_pending", status: 409 } });
		const res = await POST(request(), params);
		expect(res.status).toBe(409);
		expect(decideApproval).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ sessionId: "s1", actor: expect.objectContaining({ credential: "session" }) }),
			ID,
			{ decision: "approve", confirmEnvironmentName: undefined },
		);
	});
});
