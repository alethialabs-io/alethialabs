// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The U tests of ADR 0003 slice 5 (§11): the claim's transitions as pure functions. Each guard here
// is the one `reserveTurn`, `heartbeatTurn` and `expireSilentTurns` evaluate under their locks, so a
// test of the function is a test of the decision, not of a copy of it. The database half (the locks,
// the one connection, the hold on the same transaction) is tests/integration/agent-turn-claims.test.ts.

import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	type AcceptClassification,
	claimExpiry,
	cutAfterApprovalStep,
	decideAcceptance,
	heartbeatRenews,
	type KeyClaim,
	rearmedClaim,
	TURN_AGE_BOUND_MS,
	TURN_BUDGET_MS,
	TURN_HEARTBEAT_MS,
	TURN_LEASE_MS,
	TURN_REFUSAL_STATUS,
	turnIdSchema,
	turnRefusal,
} from "@/lib/agent/turn-claims";
import { classifyTurn, continuationKey } from "@/lib/agent/turn-key";

const NOW = new Date("2026-10-08T12:00:00.000Z");

/** `ms` milliseconds before {@link NOW}. */
function ago(ms: number): Date {
	return new Date(NOW.getTime() - ms);
}

/** `ms` milliseconds after {@link NOW}. */
function ahead(ms: number): Date {
	return new Date(NOW.getTime() + ms);
}

const ANSWER: AcceptClassification = {
	outcome: "accept",
	kind: "answer",
	attemptKey: "answer",
	appendTurn: false,
};

/** A key claim in `state`. */
function claim(state: KeyClaim["state"], over: Partial<KeyClaim> = {}): KeyClaim {
	return { id: "c-1", state, partial: false, attemptNo: 1, ...over };
}

describe("the bounds (§8.2)", () => {
	it("are 15 minutes, a 90 s lease renewed every 30 s, and an age bound of their sum", () => {
		expect(TURN_BUDGET_MS).toBe(900_000);
		expect(TURN_LEASE_MS).toBe(90_000);
		expect(TURN_HEARTBEAT_MS * 3).toBe(TURN_LEASE_MS);
		expect(TURN_AGE_BOUND_MS).toBe(TURN_BUDGET_MS + TURN_LEASE_MS);
	});
});

describe("C8's guard: claimExpiry", () => {
	it("leaves a young claim with a fresh lease running", () => {
		expect(claimExpiry({ leaseUntil: ahead(60_000), acceptedAt: ago(30_000) }, NOW)).toBeNull();
	});

	it("expires a claim whose lease is silent", () => {
		expect(claimExpiry({ leaseUntil: ago(1), acceptedAt: ago(120_000) }, NOW)).toBe("lease-silent");
	});

	it("expires a claim past its age bound although its lease is fresh (a leaked heartbeat)", () => {
		expect(
			claimExpiry({ leaseUntil: ahead(80_000), acceptedAt: ago(TURN_AGE_BOUND_MS + 1) }, NOW),
		).toBe("age-bound");
		// At the bound exactly it is still within its budget.
		expect(claimExpiry({ leaseUntil: ahead(80_000), acceptedAt: ago(TURN_AGE_BOUND_MS) }, NOW)).toBeNull();
	});
});

describe("C5's guard: heartbeatRenews", () => {
	const running = { state: "running" as const, token: "tok-1", acceptedAt: ago(60_000) };

	it("renews the running attempt the token names", () => {
		expect(heartbeatRenews(running, "tok-1", NOW)).toBe(true);
	});

	it("renews nothing for another token (a re-armed attempt) or a claim that is not running", () => {
		expect(heartbeatRenews(running, "tok-2", NOW)).toBe(false);
		for (const state of ["expired", "failed", "answered"] as const) {
			expect(heartbeatRenews({ ...running, state }, "tok-1", NOW)).toBe(false);
		}
	});

	it("a heartbeat for an attempt older than TURN_BUDGET_MS + 90 s renews nothing", () => {
		expect(heartbeatRenews({ ...running, acceptedAt: ago(TURN_AGE_BOUND_MS + 1) }, "tok-1", NOW)).toBe(
			false,
		);
		expect(heartbeatRenews({ ...running, acceptedAt: ago(TURN_AGE_BOUND_MS) }, "tok-1", NOW)).toBe(true);
	});
});

describe("acceptance: decideAcceptance (C1-C4r, §5.1 steps 4-5)", () => {
	it("inserts a claim for a key with no row (C1)", () => {
		expect(decideAcceptance(ANSWER, null, false)).toEqual({ action: "insert" });
	});

	it("re-arms a failed or an expired attempt (C2)", () => {
		for (const state of ["failed", "expired"] as const) {
			expect(decideAcceptance(ANSWER, claim(state), false)).toEqual({
				action: "rearm",
				from: state,
				claim: claim(state),
			});
		}
	});

	it("a duplicate of a running turn is turn-in-progress, not thread-busy", () => {
		// The running attempt IS the other running attempt of the thread; its own key decides first.
		expect(decideAcceptance(ANSWER, claim("running"), true)).toEqual({
			action: "refuse",
			refusal: "turn-in-progress",
		});
	});

	it("refuses an answered key as turn-answered (C4), before thread-busy", () => {
		expect(decideAcceptance(ANSWER, claim("answered"), true)).toEqual({
			action: "refuse",
			refusal: "turn-answered",
		});
	});

	it("refuses a new key while another attempt of the thread runs (thread-busy), also for a re-arm", () => {
		expect(decideAcceptance(ANSWER, null, true)).toEqual({ action: "refuse", refusal: "thread-busy" });
		expect(decideAcceptance(ANSWER, claim("failed"), true)).toEqual({
			action: "refuse",
			refusal: "thread-busy",
		});
	});

	it("a failed answer attempt is re-armed with attempt_no 2 and a new token", () => {
		const decision = decideAcceptance(ANSWER, claim("failed", { attemptNo: 1 }), false);
		if (decision.action !== "rearm") throw new Error(`expected a re-arm, got ${decision.action}`);
		const values = rearmedClaim(decision.claim, "tok-new");
		expect(values).toMatchObject({ state: "running", token: "tok-new", attempt_no: 2, error: null });
	});

	it("a resume re-arms with answer_id null, partial false and finished_at null", () => {
		expect(rearmedClaim({ attemptNo: 3 }, "tok-r")).toEqual({
			state: "running",
			token: "tok-r",
			attempt_no: 4,
			answer_id: null,
			partial: false,
			error: null,
			finished_at: null,
			hold_id: null,
		});
	});
});

describe("C4r: a continuation whose claim is answered and partial", () => {
	const TC = "call-approve-1";
	const approved = {
		status: "approved",
		operation: "plan_project",
		projectId: "7f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
		environmentId: null,
		jobId: "0d6c1e2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a",
	};
	const u: UIMessage = { id: "u-1", role: "user", parts: [{ type: "text", text: "plan it" }] };
	/** `a` with the approval stored, then a continuation tail that ended partial. */
	const a: UIMessage = {
		id: "a-1",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{
				type: "tool-propose_operation",
				toolCallId: TC,
				state: "output-available",
				input: { operation: "plan_project" },
				output: approved,
			},
			{ type: "step-start" },
			{ type: "text", text: "Planning has starte", state: "done" },
		],
	};
	const key = continuationKey("a-1", [TC]);

	/** The classification of the continuation request against `claims`. */
	function classify(partial: boolean, revision = 4) {
		const cls = classifyTurn({
			turn: { trigger: "submit-message", turnId: "u-1", baseRevision: 4, answerId: "a-1", toolCallIds: [TC] },
			requestMessages: [u, a],
			stored: [u, a],
			revision,
			claims: [{ attemptKey: key, state: "answered", partial }],
		});
		if (cls.outcome !== "accept") throw new Error(`expected an accept, got ${cls.outcome}`);
		return cls;
	}

	it("is resumed (C4r), not refused turn-answered", () => {
		const cls = classify(true);
		expect(cls).toMatchObject({ kind: "continue", mode: "resume", attemptKey: key });
		const decision = decideAcceptance(cls, claim("answered", { partial: true }), false);
		expect(decision).toMatchObject({ action: "rearm", from: "answered" });
	});

	it("a finished (not partial) continuation is turn-answered", () => {
		const cls = classify(false);
		expect(decideAcceptance(cls, claim("answered"), false)).toEqual({
			action: "refuse",
			refusal: "turn-answered",
		});
	});

	it("the resume answers from a cut after the approval's step: the stored output kept, the tail dropped", () => {
		const cut = cutAfterApprovalStep(a, [TC]);
		expect(cut.id).toBe("a-1");
		expect(cut.parts).toEqual(a.parts.slice(0, 2));
		expect(cut.parts[1]).toMatchObject({ toolCallId: TC, output: approved });
	});

	it("a message with no part of the pending calls is not cut", () => {
		expect(cutAfterApprovalStep(a, ["other"])).toBe(a);
	});
});

describe("refusals (§9.3)", () => {
	const stored: UIMessage[] = [
		{ id: "u-1", role: "user", parts: [{ type: "text", text: "hi" }] },
		{ id: "a-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
	];

	it("reports turn-answered as committed even for a turn id that is not stored (#5721 advisory 1)", () => {
		expect(turnRefusal("turn-answered", "u-unstored", stored, 3)).toEqual({
			refusal: "turn-answered",
			turnId: "u-unstored",
			committed: true,
			textCommitted: true,
			answered: true,
			revision: 3,
			answerId: null,
		});
	});

	it("an edited re-send is committed but its text is not, with the stored answer", () => {
		expect(turnRefusal("turn-committed-different-text", "u-1", stored, 3)).toMatchObject({
			committed: true,
			textCommitted: false,
			answered: true,
			answerId: "a-1",
		});
	});

	it("turn-in-progress is committed and unanswered", () => {
		expect(turnRefusal("turn-in-progress", "u-1", stored, 3)).toMatchObject({
			committed: true,
			textCommitted: true,
			answered: false,
		});
	});

	it("the uncommitted refusals say so whatever the transcript holds", () => {
		for (const code of ["thread-busy", "transcript-stale", "thread-deleted", "thread-not-found"] as const) {
			expect(turnRefusal(code, "u-1", stored, null)).toMatchObject({
				committed: false,
				textCommitted: false,
				answered: false,
			});
		}
	});

	it("maps each refusal to §9.3's status", () => {
		expect(TURN_REFUSAL_STATUS["turn-in-progress"]).toBe(409);
		expect(TURN_REFUSAL_STATUS["thread-deleted"]).toBe(410);
		expect(TURN_REFUSAL_STATUS["thread-not-found"]).toBe(404);
		expect(TURN_REFUSAL_STATUS["project-not-found"]).toBe(404);
		expect(TURN_REFUSAL_STATUS["org-forbidden"]).toBe(403);
	});
});

describe("turnIdSchema (§4.1)", () => {
	it("accepts 1-128 chars of [A-Za-z0-9_-] and a uuid", () => {
		expect(turnIdSchema.safeParse("msg_Ab-1").success).toBe(true);
		expect(turnIdSchema.safeParse("0d6c1e2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a").success).toBe(true);
		expect(turnIdSchema.safeParse("x".repeat(128)).success).toBe(true);
	});

	it("refuses an empty, an over-long, or a punctuated id", () => {
		for (const bad of ["", "x".repeat(129), "a b", "a/b", "a'b"]) {
			expect(turnIdSchema.safeParse(bad).success).toBe(false);
		}
	});
});
