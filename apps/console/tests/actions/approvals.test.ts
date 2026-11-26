// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// decideApplyApproval (app/server/actions/approvals.ts): only a person in a console session decides.
// No session, or an actor that is not that session's own `session` credential, is refused before the
// engine is asked; a signed-in person's decision reaches it with the session it was made in.

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

import { decideApplyApproval } from "@/app/server/actions/approvals";
import { ApprovalError, type ApprovalErrorCode } from "@/lib/approvals/refusal";

const ID = "00000000-0000-4000-8000-000000000050";
const USER = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	vi.clearAllMocks();
	getSession.mockResolvedValue({ user: { id: USER }, session: { id: "s1", createdAt: new Date() } });
	currentActor.mockResolvedValue({ userId: USER, orgId: USER, credential: "session" });
	withActorScope.mockImplementation(async (_actor: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}));
});

describe("decideApplyApproval", () => {
	it("refuses with no session, before the engine is asked", async () => {
		getSession.mockResolvedValue(null);
		expect((await decideApplyApproval({ approvalId: ID, decision: "approve" })).ok).toBe(false);
		expect(decideApproval).not.toHaveBeenCalled();
	});

	it.each([
		["an agent credential", { userId: USER, orgId: USER, credential: "agent_in_app" }],
		["another person", { userId: "someone-else", orgId: USER, credential: "session" }],
	])("refuses %s, before the engine is asked", async (_name, actor) => {
		currentActor.mockResolvedValue(actor);
		expect((await decideApplyApproval({ approvalId: ID, decision: "approve" })).ok).toBe(false);
		expect(decideApproval).not.toHaveBeenCalled();
	});

	it("refuses a credential that is not a person with the not_a_person code", async () => {
		currentActor.mockResolvedValue({ userId: USER, orgId: USER, credential: "agent_in_app" });
		expect(await decideApplyApproval({ approvalId: ID, decision: "approve" })).toStrictEqual({
			ok: false,
			error: { kind: "conflict", message: "An approval is decided by a person signed in to the console.", code: "not_a_person" },
		});
	});

	// #7643: every engine refusal reaches the sheet with its code, so the sheet never infers which it was.
	const CODES: ReadonlyArray<[ApprovalErrorCode, "not-found" | "conflict"]> = [
		["not_found", "not-found"],
		["plan_not_approvable", "conflict"],
		["not_permitted", "conflict"],
		["not_a_person", "conflict"],
		["reauthentication_required", "conflict"],
		["self_approval", "conflict"],
		["policy_refused", "conflict"],
		["not_pending", "conflict"],
		["confirmation_mismatch", "conflict"],
	];
	it.each(CODES)("returns the engine's %s refusal as a %s carrying its code and sentence", async (code, kind) => {
		decideApproval.mockRejectedValue(new ApprovalError(code, `Refused: ${code}.`));
		expect(await decideApplyApproval({ approvalId: ID, decision: "approve" })).toStrictEqual({
			ok: false,
			error: { kind, message: `Refused: ${code}.`, code },
		});
	});

	it("returns a refusal the engine answers as a value (expired, superseded) with its code", async () => {
		decideApproval.mockResolvedValue({ ok: false, error: new ApprovalError("not_pending", "That approval expired.") });
		expect(await decideApplyApproval({ approvalId: ID, decision: "approve" })).toStrictEqual({
			ok: false,
			error: { kind: "conflict", message: "That approval expired.", code: "not_pending" },
		});
	});

	it("hands a signed-in person's decision to the engine with the session it was made in", async () => {
		decideApproval.mockResolvedValue({ ok: false, error: new ApprovalError("not_pending", "That approval expired.") });
		const result = await decideApplyApproval({ approvalId: ID, decision: "reject" });
		expect(result.ok).toBe(false);
		expect(decideApproval).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ sessionId: "s1", actor: expect.objectContaining({ credential: "session" }) }),
			ID,
			{ decision: "reject", confirmEnvironmentName: undefined },
		);
	});
});
