// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the claim state machine of ADR 0003 slice 5 (§5, §8, §11's I tests).
// A chat turn is answered by the model, and billed, exactly once. Every test asks the database:
//
//   acceptance   two concurrent accepts of one turn → one claim, one hold; the pin read under the
//                thread lock; thread-busy; another owner's id; a reaped id recreated with its old
//                claims gone; a silent claim expired by the next accept; a 402 that rolls back the
//                claim and the appended turn; ONE connection (a pool of one cannot deadlock it)
//   finalize     settled in its own transaction (and the spend alert only after the commit); C7;
//                lost after expiry; moved; a partial answer floored at the reserve; a metering write
//                that fails rolls the answer back; the delete sequence of case 18
//   the rest     the heartbeat and its age bound; the sweep's C8 (lease or age); the continuation,
//                its schema refusal and its resume; a regenerate; no deadlock between an acceptance
//                running C8 and the finalize of the same claim; self-host reserves nothing
//
// Needs a migrated Postgres on ALETHIA_DATABASE_URL (CI's Integration job); skips when unreachable.

import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

// The spend alert reads the ledger on a pooled connection: record what it saw, and when.
const alertSaw = vi.hoisted((): { reads: Promise<void>[]; settled: boolean[] } => ({ reads: [], settled: [] }));
vi.mock("@/lib/billing/ai-spend-alert", () => ({
	checkAiSpendThreshold: vi.fn(() => Promise.resolve()),
}));
// The real metering, wrapped so one test can make the write fail INSIDE finalize's transaction.
vi.mock("@/lib/billing/agent-metering", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/billing/agent-metering")>();
	return { ...real, recordAgentTurnUsage: vi.fn(real.recordAgentTurnUsage) };
});

import {
	type AcceptedTurn,
	expireSilentTurns,
	finalizeTurn,
	heartbeatTurn,
	type ReserveTurnInput,
	type ReserveTurnResult,
	reserveTurn,
	TURN_AGE_BOUND_MS,
} from "@/lib/agent/turn-claims";
import { THREAD_DELETED } from "@/lib/agent/transcript-save";
import { continuationKey, type TurnRequest } from "@/lib/agent/turn-key";
import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import { AiBudgetError, METERED_RESERVE_CREDITS } from "@/lib/billing/ai-guard";
import { checkAiSpendThreshold } from "@/lib/billing/ai-spend-alert";
import { getServiceDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { agentThreads, agentTurnClaims, aiUsageLedger } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { describeIfDb } from "./db";

const HAIKU = "anthropic/claude-haiku-4-5";
const STEPS = [{ model: HAIKU, usage: { inputTokens: 1200, outputTokens: 600 } }];

const users: string[] = [];
const orgs: string[] = [];

/** A fresh user and their personal org (tracked for teardown). */
function freshUser(): { user: string; org: string } {
	const user = randomUUID();
	users.push(user);
	orgs.push(user);
	return { user, org: user };
}

/** A fresh team org id (tracked for teardown). */
function freshOrg(): string {
	const id = randomUUID();
	orgs.push(id);
	return id;
}

/** A user message. */
function userMsg(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] };
}

/** An assistant answer with one step of text. */
function answerMsg(id: string, text: string): UIMessage {
	return { id, role: "assistant", parts: [{ type: "step-start" }, { type: "text", text, state: "done" }] };
}

/** Insert a thread for `user` on the service role and return its id. */
async function seedThread(
	user: string,
	messages: UIMessage[] = [],
	over: Partial<typeof agentThreads.$inferInsert> = {},
): Promise<string> {
	const [row] = await getServiceDb()
		.insert(agentThreads)
		.values({ user_id: user, org_id: user, title: "seeded", messages, ...over })
		.returning({ id: agentThreads.id });
	return row.id;
}

/** The request of a submit of `u` into `threadId` at `baseRevision`. */
function submit(
	user: string,
	org: string,
	threadId: string,
	messages: UIMessage[],
	turn: Partial<TurnRequest> & { baseRevision: number },
): ReserveTurnInput {
	const last = [...messages].reverse().find((m) => m.role === "user");
	return {
		userId: user,
		orgId: org,
		threadId,
		threadKind: "agent",
		projectId: null,
		aiKind: "agent",
		turn: { trigger: "submit-message", turnId: last?.id ?? "none", ...turn },
		messages,
	};
}

/** The accepted turn of a result that must be an acceptance. */
function accepted(result: ReserveTurnResult): AcceptedTurn {
	if (result.outcome !== "accepted") throw new Error(`expected an acceptance, got ${JSON.stringify(result)}`);
	return result.turn;
}

/** The refusal code of a result that must be a refusal. */
function refusalOf(result: ReserveTurnResult): string {
	if (result.outcome !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
	return result.body.refusal;
}

/** The thread row. */
async function thread(id: string) {
	const [row] = await getServiceDb().select().from(agentThreads).where(eq(agentThreads.id, id));
	return row;
}

/** Every claim of a thread id. */
async function claims(threadId: string) {
	return getServiceDb().select().from(agentTurnClaims).where(eq(agentTurnClaims.thread_id, threadId));
}

/** Every ledger row of an org. */
async function ledger(org: string) {
	return getServiceDb().select().from(aiUsageLedger).where(eq(aiUsageLedger.org_id, org));
}

/** One ledger row by id. */
async function hold(id: string | null) {
	if (!id) throw new Error("no hold id");
	const [row] = await getServiceDb().select().from(aiUsageLedger).where(eq(aiUsageLedger.id, id));
	return row;
}

/** The hold id an accepted turn reserved. */
function holdIdOf(turn: AcceptedTurn): string {
	if (!turn.charge.settle) throw new Error("expected a hosted-billing hold");
	return turn.charge.holdId;
}

/** Make a claim's lease silent, as a crashed process leaves it. */
async function silence(claimId: string) {
	await getServiceDb()
		.update(agentTurnClaims)
		.set({ lease_until: sql`now() - interval '1 minute'` })
		.where(eq(agentTurnClaims.id, claimId));
}

/** Delete a thread as `deleteThread` does: the row goes and a tombstone takes its id. */
async function deleteAsTheUserDoes(threadId: string, user: string) {
	await getServiceDb().transaction(async (tx) => {
		await tx.delete(agentThreads).where(eq(agentThreads.id, threadId));
		await tx.insert(agentThreads).values({
			id: threadId,
			user_id: user,
			org_id: user,
			kind: "agent",
			title: "",
			status: THREAD_DELETED,
		});
	});
}

/** A thread with one accepted first turn: `[u]` stored, one running claim, one hold. */
async function acceptedFirstTurn(text = "what failed?") {
	const { user, org } = freshUser();
	const threadId = await seedThread(user);
	const u = userMsg(`u-${randomUUID()}`, text);
	const turn = accepted(await reserveTurn(submit(user, org, threadId, [u], { baseRevision: 1 })));
	return { user, org, threadId, u, turn };
}

describeIfDb("the claim state machine (ADR 0003 slice 5)", () => {
	beforeAll(() => {
		// The hosted-billing path (isStripeConfigured() checks the key's presence).
		process.env.STRIPE_SECRET_KEY ||= "sk_test_agent_turn_claims_integration";
	});

	beforeEach(() => {
		alertSaw.reads = [];
		alertSaw.settled = [];
		vi.mocked(checkAiSpendThreshold).mockClear();
		vi.mocked(recordAgentTurnUsage).mockClear();
	});

	afterAll(async () => {
		const db = getServiceDb();
		if (users.length > 0) {
			await db.delete(agentTurnClaims).where(inArray(agentTurnClaims.user_id, users));
			await db.delete(agentThreads).where(inArray(agentThreads.user_id, users));
		}
		if (orgs.length > 0) await db.delete(aiUsageLedger).where(inArray(aiUsageLedger.org_id, orgs));
	});

	// ── Acceptance ───────────────────────────────────────────────────────────────────────────────

	it("accepts a first turn: the turn appended, the pin written, one running claim and one hold, in one commit", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn();
		const row = await thread(threadId);
		expect(row.messages).toEqual([u]);
		expect(row.revision).toBe(2);
		expect(row.billing_org_id).toBe(org);
		expect(turn).toMatchObject({ acceptedRevision: 2, attemptKey: "answer", attemptNo: 1, kind: "answer" });
		expect(turn.modelInput).toEqual([u]);
		const [c] = await claims(threadId);
		expect(c).toMatchObject({
			state: "running",
			user_id: user,
			turn_id: u.id,
			token: turn.token,
			billing_org_id: org,
			hold_id: holdIdOf(turn),
			accepted_revision: 2,
		});
		const h = await hold(holdIdOf(turn));
		expect(h).toMatchObject({ credits: METERED_RESERVE_CREDITS, settled_at: null, user_id: user });
	});

	it("two concurrent accepts of one turn: one running claim, one hold row, one turn-in-progress", async () => {
		const { user, org } = freshUser();
		const threadId = await seedThread(user);
		const u = userMsg("u-dup", "deploy staging");
		const req = submit(user, org, threadId, [u], { baseRevision: 1 });
		const results = await Promise.all([reserveTurn(req), reserveTurn(req)]);
		const acceptedOnes = results.filter((r) => r.outcome === "accepted");
		const refused = results.filter((r) => r.outcome === "refused");
		expect(acceptedOnes).toHaveLength(1);
		expect(refused).toHaveLength(1);
		const [r] = refused;
		if (r.outcome !== "refused") throw new Error("unreachable");
		expect(r.status).toBe(409);
		expect(r.body).toMatchObject({ refusal: "turn-in-progress", committed: true, answered: false });
		expect(await claims(threadId)).toHaveLength(1);
		expect(await ledger(org)).toHaveLength(1);
		expect((await thread(threadId)).messages).toEqual([u]);
	});

	it("accepts for one thread from orgs A and B do not deadlock: the pin is read under the thread lock", async () => {
		const { user } = freshUser();
		const A = freshOrg();
		const B = freshOrg();
		const threadId = await seedThread(user);
		const u = userMsg("u-ab", "list projects");
		const results = await Promise.all([
			reserveTurn(submit(user, A, threadId, [u], { baseRevision: 1 })),
			reserveTurn(submit(user, B, threadId, [u], { baseRevision: 1 })),
		]);
		expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
		// The loser read the winner's pin under the lock — never a second turn under its own org.
		const moved = results.find((r) => r.outcome === "pin-moved");
		const winner = results.find((r) => r.outcome === "accepted");
		if (!moved || moved.outcome !== "pin-moved" || !winner || winner.outcome !== "accepted") {
			throw new Error(`expected one acceptance and one pin-moved, got ${JSON.stringify(results)}`);
		}
		expect(moved.pinnedOrgId).toBe(winner.turn.billingOrgId);
		expect((await thread(threadId)).billing_org_id).toBe(winner.turn.billingOrgId);
		expect((await ledger(A)).length + (await ledger(B)).length).toBe(1);
	});

	it("a first turn from orgs A and B into a free id: one acceptance, the other is pin-moved, never thread-not-found", async () => {
		// The two acceptances take DIFFERENT advisory locks, so they run concurrently: the second's
		// INSERT waits on the first's uncommitted row, does nothing, and must then lock that live row.
		for (let i = 0; i < 3; i++) {
			const { user } = freshUser();
			const A = freshOrg();
			const B = freshOrg();
			const threadId = randomUUID();
			const u = userMsg(`u-fresh-${i}`, "list clusters");
			const results = await Promise.all([
				reserveTurn(submit(user, A, threadId, [u], { baseRevision: 1 })),
				reserveTurn(submit(user, B, threadId, [u], { baseRevision: 1 })),
			]);
			const winner = results.find((r) => r.outcome === "accepted");
			const moved = results.find((r) => r.outcome === "pin-moved");
			if (!winner || winner.outcome !== "accepted" || !moved || moved.outcome !== "pin-moved") {
				throw new Error(`expected one acceptance and one pin-moved, got ${JSON.stringify(results)}`);
			}
			expect(moved.pinnedOrgId).toBe(winner.turn.billingOrgId);
			// The route re-resolves the pin and calls once more: the claim it collides on refuses it.
			const again = await reserveTurn(
				submit(user, winner.turn.billingOrgId, threadId, [u], { baseRevision: winner.turn.acceptedRevision }),
			);
			if (again.outcome !== "refused") throw new Error(JSON.stringify(again));
			expect(again.body).toMatchObject({ refusal: "turn-in-progress", committed: true });
			expect(await claims(threadId)).toHaveLength(1);
			expect((await ledger(A)).length + (await ledger(B)).length).toBe(1);
		}
	});

	it("one turn driven from org A and org B: the second accept sees the first claim and refuses", async () => {
		const { user } = freshUser();
		const A = freshOrg();
		const B = freshOrg();
		const threadId = await seedThread(user);
		const u = userMsg("u-two-orgs", "what changed?");
		accepted(await reserveTurn(submit(user, A, threadId, [u], { baseRevision: 1 })));
		const fromB = await reserveTurn(submit(user, B, threadId, [u], { baseRevision: 1 }));
		expect(fromB).toEqual({ outcome: "pin-moved", pinnedOrgId: A });
		// The route re-resolves the pinned org and calls once more: the claim it collides on refuses it.
		const again = await reserveTurn(submit(user, A, threadId, [u], { baseRevision: 2 }));
		expect(refusalOf(again)).toBe("turn-in-progress");
		expect(await ledger(B)).toHaveLength(0);
		expect(await ledger(A)).toHaveLength(1);
	});

	it("two new turns at one base: one running, one thread-busy", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn();
		const y = userMsg("u-y", "and prod?");
		const busy = await reserveTurn(submit(user, org, threadId, [u, y], { baseRevision: turn.acceptedRevision }));
		if (busy.outcome !== "refused") throw new Error(JSON.stringify(busy));
		expect(busy.body).toMatchObject({ refusal: "thread-busy", committed: false, textCommitted: false });
		expect((await thread(threadId)).messages).toEqual([u]);
		expect(await ledger(org)).toHaveLength(1);
		// A tab at an older base is stale, not busy.
		const stale = await reserveTurn(submit(user, org, threadId, [y], { baseRevision: 1 }));
		expect(refusalOf(stale)).toBe("transcript-stale");
	});

	it("a stored unanswered turn re-sent with different text is turn-committed-different-text, with no hold", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn("deploy staging");
		const edited = userMsg(u.id, "deploy prod");
		const r = await reserveTurn(submit(user, org, threadId, [edited], { baseRevision: turn.acceptedRevision }));
		if (r.outcome !== "refused") throw new Error(JSON.stringify(r));
		expect(r.body).toMatchObject({ refusal: "turn-committed-different-text", committed: true, textCommitted: false });
		expect(await ledger(org)).toHaveLength(1);
	});

	it("a claim on another user's thread id is refused, and nothing is written", async () => {
		const owner = freshUser();
		const intruder = freshUser();
		const threadId = await seedThread(owner.user, [userMsg("u-own", "mine")]);
		const r = await reserveTurn(
			submit(intruder.user, intruder.org, threadId, [userMsg("u-x", "theirs")], { baseRevision: 1 }),
		);
		if (r.outcome !== "refused") throw new Error(JSON.stringify(r));
		expect(r.status).toBe(404);
		expect(r.body.refusal).toBe("thread-not-found");
		expect(await claims(threadId)).toHaveLength(0);
		expect(await ledger(intruder.org)).toHaveLength(0);
		expect(await thread(threadId)).toMatchObject({ user_id: owner.user, revision: 1, billing_org_id: null });
	});

	it("refuses a deleted thread (410) and a thread of another kind or project (404)", async () => {
		const { user, org } = freshUser();
		const tomb = await seedThread(user, [], { status: THREAD_DELETED, title: "" });
		expect(refusalOf(await reserveTurn(submit(user, org, tomb, [userMsg("u-1", "hi")], { baseRevision: 1 })))).toBe(
			"thread-deleted",
		);
		const support = await seedThread(user, [], { kind: "support" });
		expect(refusalOf(await reserveTurn(submit(user, org, support, [userMsg("u-2", "hi")], { baseRevision: 1 })))).toBe(
			"thread-not-found",
		);
		const project = await seedThread(user, [], { project_id: randomUUID() });
		expect(refusalOf(await reserveTurn(submit(user, org, project, [userMsg("u-3", "hi")], { baseRevision: 1 })))).toBe(
			"thread-not-found",
		);
		// A missing support thread is never recreated (§5.1 step 2).
		const missing = randomUUID();
		const r = await reserveTurn({ ...submit(user, org, missing, [userMsg("u-4", "hi")], { baseRevision: 1 }), threadKind: "support", aiKind: "support" });
		expect(refusalOf(r)).toBe("thread-not-found");
		expect(await thread(missing)).toBeUndefined();
		expect(await ledger(org)).toHaveLength(0);
	});

	it("an agent turn that recreates a reaped thread id runs C8 first and deletes that id's old claims", async () => {
		const { user, org } = freshUser();
		const threadId = randomUUID(); // reaped: no row
		const oldHold = randomUUID();
		await getServiceDb().insert(aiUsageLedger).values({
			id: oldHold,
			org_id: org,
			user_id: user,
			kind: "agent",
			credits: METERED_RESERVE_CREDITS,
			source: "included",
		});
		const base = {
			thread_id: threadId,
			user_id: user,
			billing_org_id: org,
			accepted_revision: 2,
			lease_until: sql`now() - interval '5 minutes'`,
			accepted_at: sql`now() - interval '10 minutes'`,
		};
		await getServiceDb().insert(agentTurnClaims).values([
			// The old thread answered this turn id: it must not make the new thread say turn-answered.
			{ ...base, turn_id: "u-reused", attempt_key: "answer", state: "answered", token: randomUUID(), answer_id: "a-old" },
			// A dead process's attempt, silent: C8 ends it (releasing its hold) before the cleanup.
			{ ...base, turn_id: "u-dead", attempt_key: "answer", state: "running", token: randomUUID(), hold_id: oldHold },
		]);
		const u = userMsg("u-reused", "start over");
		const turn = accepted(await reserveTurn(submit(user, org, threadId, [u], { baseRevision: 1 })));
		const after = await claims(threadId);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ id: turn.claimId, state: "running", turn_id: "u-reused", attempt_no: 1 });
		expect(await hold(oldHold)).toMatchObject({ credits: 0 });
		expect((await hold(oldHold)).settled_at).not.toBeNull();
		expect(await thread(threadId)).toMatchObject({ user_id: user, kind: "agent", messages: [u], revision: 2 });
	});

	it("a silent running claim is expired by the next accept and its hold is 0; the retry re-arms the key (C8, C2)", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn();
		await silence(turn.claimId);
		const retry = accepted(
			await reserveTurn({
				...submit(user, org, threadId, [u], { baseRevision: turn.acceptedRevision }),
				turn: { trigger: "regenerate-message", turnId: u.id, baseRevision: turn.acceptedRevision },
			}),
		);
		expect(retry.claimId).toBe(turn.claimId);
		expect(retry.token).not.toBe(turn.token);
		expect(retry.attemptNo).toBe(2);
		const first = await hold(holdIdOf(turn));
		expect(first.credits).toBe(0);
		expect(first.settled_at).not.toBeNull();
		expect(await hold(holdIdOf(retry))).toMatchObject({ credits: METERED_RESERVE_CREDITS, settled_at: null });
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "running", token: retry.token, attempt_no: 2, hold_id: holdIdOf(retry) });
		// The turn was stored once; the retry appended nothing.
		expect((await thread(threadId)).messages).toEqual([u]);
	});

	it("a budget refusal rolls back the claim and the appended turn (402)", async () => {
		const { user, org } = freshUser();
		await getServiceDb()
			.insert(aiUsageLedger)
			.values({ org_id: org, user_id: user, kind: "agent", credits: 130, source: "included" });
		const threadId = await seedThread(user);
		const r = await reserveTurn(submit(user, org, threadId, [userMsg("u-broke", "hi")], { baseRevision: 1 }));
		if (r.outcome !== "budget") throw new Error(JSON.stringify(r));
		expect(r.error).toBeInstanceOf(AiBudgetError);
		expect(await thread(threadId)).toMatchObject({ messages: [], revision: 1, billing_org_id: null });
		expect(await claims(threadId)).toHaveLength(0);
		expect(await ledger(org)).toHaveLength(1); // the seed alone
	});

	it("reserveTurn opens one connection: with a service pool of ONE it still completes, C8 included", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn();
		await silence(turn.claimId);
		const url = process.env.ALETHIA_DATABASE_URL ?? "";
		const original = globalThis.__alethiaServiceDb;
		const originalApp = globalThis.__alethiaAppDb;
		const one = postgres(url, { max: 1, prepare: false });
		const nowhere = postgres("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1, connect_timeout: 1 });
		// Any second checkout from the service pool would wait for the one connection the acceptance
		// holds, for ever; any use of the app pool fails at once.
		globalThis.__alethiaServiceDb = drizzle(one, { schema, casing: "snake_case" });
		globalThis.__alethiaAppDb = drizzle(nowhere, { schema, casing: "snake_case" });
		try {
			const result = await Promise.race([
				reserveTurn({
					...submit(user, org, threadId, [u], { baseRevision: turn.acceptedRevision }),
					turn: { trigger: "regenerate-message", turnId: u.id, baseRevision: turn.acceptedRevision },
				}),
				new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 10_000)),
			]);
			if (result === "hung") throw new Error("reserveTurn waited on a second connection");
			expect(accepted(result).attemptNo).toBe(2);
		} finally {
			globalThis.__alethiaServiceDb = original;
			globalThis.__alethiaAppDb = originalApp;
			await one.end({ timeout: 1 });
			await nowhere.end({ timeout: 1 });
		}
	});

	// ── Finalize ─────────────────────────────────────────────────────────────────────────────────

	it("a committed answered claim has a settled hold row, and the spend alert runs only after the commit", async () => {
		const { org, threadId, u, turn } = await acceptedFirstTurn();
		vi.mocked(checkAiSpendThreshold).mockImplementation(async () => {
			// A pooled read: it sees only what is COMMITTED.
			const read = hold(holdIdOf(turn)).then((h) => {
				alertSaw.settled.push(h.settled_at !== null);
			});
			alertSaw.reads.push(read);
			await read;
		});
		const answer = answerMsg("a-1", "Two jobs failed.");
		const result = await finalizeTurn(turn, { answer, steps: STEPS, partial: false });
		expect(result).toEqual({ outcome: "won", state: "answered", answerId: "a-1", revision: 3 });
		const row = await thread(threadId);
		expect(row.messages).toEqual([u, answer]);
		expect(row.revision).toBe(3);
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "answered", answer_id: "a-1", partial: false });
		expect(c.finished_at).not.toBeNull();
		const h = await hold(holdIdOf(turn));
		expect(h.settled_at).not.toBeNull();
		expect(h.model).toBe(HAIKU);
		expect(h.credits).toBeGreaterThan(0);
		// The after-commit ran: exactly once, for the billing org, and it read a settled row.
		await Promise.all(alertSaw.reads);
		expect(checkAiSpendThreshold).toHaveBeenCalledTimes(1);
		expect(checkAiSpendThreshold).toHaveBeenCalledWith(org);
		expect(alertSaw.settled).toEqual([true]);
		vi.mocked(checkAiSpendThreshold).mockImplementation(() => Promise.resolve());
	});

	it("a provider error before output: failed, hold 0, turn stored unanswered; a Retry re-arms it (C7, C2)", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn();
		expect(await finalizeTurn(turn, { answer: null, steps: [], partial: false, error: "provider-error" })).toEqual({
			outcome: "won",
			state: "failed",
		});
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "failed", error: "provider-error", answer_id: null });
		expect(await hold(holdIdOf(turn))).toMatchObject({ credits: 0 });
		expect((await hold(holdIdOf(turn))).settled_at).not.toBeNull();
		expect((await thread(threadId)).messages).toEqual([u]);
		// The stream emitted only a step marker: still no model output, still C7.
		const retry = accepted(
			await reserveTurn({
				...submit(user, org, threadId, [u], { baseRevision: turn.acceptedRevision }),
				turn: { trigger: "regenerate-message", turnId: u.id, baseRevision: turn.acceptedRevision },
			}),
		);
		expect(retry).toMatchObject({ claimId: turn.claimId, attemptNo: 2 });
		expect(retry.token).not.toBe(turn.token);
		const empty: UIMessage = { id: "a-empty", role: "assistant", parts: [{ type: "step-start" }] };
		expect(await finalizeTurn(retry, { answer: empty, steps: [], partial: true, error: "aborted" })).toEqual({
			outcome: "won",
			state: "failed",
		});
	});

	it("a finalize after expiry stores nothing and does not meter (lost)", async () => {
		const { threadId, u, turn } = await acceptedFirstTurn();
		await silence(turn.claimId);
		expect((await expireSilentTurns()).expired).toBeGreaterThanOrEqual(1);
		const result = await finalizeTurn(turn, { answer: answerMsg("a-late", "Too late."), steps: STEPS, partial: false });
		expect(result).toEqual({ outcome: "lost" });
		expect(recordAgentTurnUsage).not.toHaveBeenCalled();
		expect((await thread(threadId)).messages).toEqual([u]);
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "expired", error: "lease-silent", answer_id: null });
		expect(await hold(holdIdOf(turn))).toMatchObject({ credits: 0 });
	});

	it("a finalize whose revision moved is moved: nothing stored, hold 0 (C6m)", async () => {
		const { threadId, u, turn } = await acceptedFirstTurn();
		// A writer that breaks §4.2 (nothing but the attempt may write while it runs).
		await getServiceDb()
			.update(agentThreads)
			.set({ revision: sql`${agentThreads.revision} + 1` })
			.where(eq(agentThreads.id, threadId));
		expect(await finalizeTurn(turn, { answer: answerMsg("a-m", "Hi."), steps: STEPS, partial: false })).toEqual({
			outcome: "moved",
		});
		expect((await thread(threadId)).messages).toEqual([u]);
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "failed", error: "transcript-moved" });
		expect(await hold(holdIdOf(turn))).toMatchObject({ credits: 0 });
	});

	it("abort after model output: answered partial, hold settled to at least the reserve (Q8)", async () => {
		const { threadId, turn } = await acceptedFirstTurn();
		const partialAnswer = answerMsg("a-p", "Two jobs fai");
		const result = await finalizeTurn(turn, { answer: partialAnswer, steps: [], partial: true, error: "aborted" });
		expect(result).toMatchObject({ outcome: "won", state: "answered" });
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "answered", partial: true, answer_id: "a-p" });
		const h = await hold(holdIdOf(turn));
		expect(h.credits).toBe(METERED_RESERVE_CREDITS);
		expect(h.settled_at).not.toBeNull();
	});

	it("a metering write that fails inside finalize rolls back the answer; the claim stays running and C8 releases the hold", async () => {
		const { threadId, u, turn } = await acceptedFirstTurn();
		const errorSpy = vi.spyOn(log, "error");
		const real = await vi.importActual<typeof import("@/lib/billing/agent-metering")>("@/lib/billing/agent-metering");
		vi.mocked(recordAgentTurnUsage).mockImplementationOnce(async (input, tx) => {
			await real.recordAgentTurnUsage(input, tx); // the settle is written on the tx...
			throw new Error("ledger unavailable"); // ...and then the metering write fails
		});
		await expect(
			finalizeTurn(turn, { answer: answerMsg("a-x", "Two jobs failed."), steps: STEPS, partial: false }),
		).rejects.toThrow("ledger unavailable");
		expect(errorSpy).toHaveBeenCalledWith("finalize-metering-failed", expect.objectContaining({ thread_id: threadId }));
		errorSpy.mockRestore();
		// Nothing of the finalize committed: no answer, the claim running, the hold the unsettled reserve.
		expect(await thread(threadId)).toMatchObject({ messages: [u], revision: turn.acceptedRevision });
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "running", answer_id: null });
		expect(await hold(holdIdOf(turn))).toMatchObject({ credits: METERED_RESERVE_CREDITS, settled_at: null });
		// The route died with it: its lease goes silent, and C8 releases the hold to 0.
		await silence(turn.claimId);
		await expireSilentTurns();
		expect((await claims(threadId))[0].state).toBe("expired");
		expect(await hold(holdIdOf(turn))).toMatchObject({ credits: 0 });
	});

	it("C8 expires attempt A, a Retry re-arms B, the thread is deleted: A's finalize is lost and stores and settles nothing, B's lands in one Recovered thread and settles once", async () => {
		const { user, org, threadId, u, turn: a } = await acceptedFirstTurn("deploy staging");
		await silence(a.claimId);
		const b = accepted(
			await reserveTurn({
				...submit(user, org, threadId, [u], { baseRevision: a.acceptedRevision }),
				turn: { trigger: "regenerate-message", turnId: u.id, baseRevision: a.acceptedRevision },
			}),
		);
		await deleteAsTheUserDoes(threadId, user);
		// The claim survived the delete (no foreign key, no cascade): B's heartbeat still matches.
		expect(await heartbeatTurn(b)).toBe(true);

		const lostA = await finalizeTurn(a, { answer: answerMsg("a-A", "Planned by A."), steps: STEPS, partial: false });
		expect(lostA).toEqual({ outcome: "lost" });
		const wonB = await finalizeTurn(b, { answer: answerMsg("a-B", "Planned by B."), steps: STEPS, partial: false });
		if (wonB.outcome !== "deleted") throw new Error(JSON.stringify(wonB));

		const live = await getServiceDb()
			.select()
			.from(agentThreads)
			.where(and(eq(agentThreads.user_id, user), sql`${agentThreads.status} <> ${THREAD_DELETED}`));
		expect(live).toHaveLength(1);
		expect(live[0]).toMatchObject({ id: wonB.recoveredThreadId, title: "Recovered: deploy staging" });
		expect(live[0].messages).toEqual([u, answerMsg("a-B", "Planned by B.")]);
		expect(await thread(threadId)).toMatchObject({ status: THREAD_DELETED, messages: [] });
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "answered", token: b.token, answer_id: "a-B" });
		// A's hold: released to 0 by C8, untouched since. B's: settled once, at its real cost.
		expect(await hold(holdIdOf(a))).toMatchObject({ credits: 0, model: null });
		const hb = await hold(holdIdOf(b));
		expect(hb.settled_at).not.toBeNull();
		expect(hb.model).toBe(HAIKU);
		expect((await ledger(org)).filter((r) => r.model !== null)).toHaveLength(1);
	});

	it("an acceptance running C8 on a claim whose route is finalizing does not deadlock", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn();
		await silence(turn.claimId);
		const [fin, acc] = await Promise.all([
			finalizeTurn(turn, { answer: answerMsg("a-race", "Done."), steps: STEPS, partial: false }),
			reserveTurn({
				...submit(user, org, threadId, [u], { baseRevision: turn.acceptedRevision }),
				turn: { trigger: "regenerate-message", turnId: u.id, baseRevision: turn.acceptedRevision },
			}),
		]);
		// Either order is correct; both are one transaction each, serialized by the thread lock. The
		// finalize won (the retry is turn-answered, one hold, settled at cost), or the acceptance's C8
		// did first (the finalize is lost, its hold released to 0, the retry re-armed with its own).
		const seen = {
			finalize: fin.outcome,
			acceptance: acc.outcome === "refused" ? acc.body.refusal : acc.outcome === "accepted" ? `attempt ${acc.turn.attemptNo}` : acc.outcome,
			firstHoldReleased: (await hold(holdIdOf(turn))).credits === 0,
			holds: (await ledger(org)).length,
		};
		expect([
			{ finalize: "won", acceptance: "turn-answered", firstHoldReleased: false, holds: 1 },
			{ finalize: "lost", acceptance: "attempt 2", firstHoldReleased: true, holds: 2 },
		]).toContainEqual(seen);
	});

	// ── The heartbeat and the sweep ──────────────────────────────────────────────────────────────

	it("a heartbeat renews the running attempt's lease, and renews nothing once it was expired or re-armed", async () => {
		const { user, org, threadId, u, turn } = await acceptedFirstTurn();
		await getServiceDb()
			.update(agentTurnClaims)
			.set({ lease_until: sql`now() + interval '5 seconds'` })
			.where(eq(agentTurnClaims.id, turn.claimId));
		expect(await heartbeatTurn(turn)).toBe(true);
		const [renewed] = await getServiceDb()
			.select({ fresh: sql<boolean>`${agentTurnClaims.lease_until} > now() + interval '80 seconds'` })
			.from(agentTurnClaims)
			.where(eq(agentTurnClaims.id, turn.claimId));
		expect(renewed.fresh).toBe(true);
		// Another user's handle on the same claim renews nothing.
		expect(await heartbeatTurn({ ...turn, userId: randomUUID() })).toBe(false);
		await silence(turn.claimId);
		const retry = accepted(
			await reserveTurn({
				...submit(user, org, threadId, [u], { baseRevision: turn.acceptedRevision }),
				turn: { trigger: "regenerate-message", turnId: u.id, baseRevision: turn.acceptedRevision },
			}),
		);
		expect(await heartbeatTurn(turn)).toBe(false); // the old token: the route must abort
		expect(await heartbeatTurn(retry)).toBe(true);
	});

	it("a heartbeat renews nothing past the age bound, and the sweep expires that claim although its lease is fresh", async () => {
		const { threadId, turn } = await acceptedFirstTurn();
		await getServiceDb()
			.update(agentTurnClaims)
			.set({ accepted_at: sql`now() - make_interval(secs => ${TURN_AGE_BOUND_MS / 1000 + 5})` })
			.where(eq(agentTurnClaims.id, turn.claimId));
		expect(await heartbeatTurn(turn)).toBe(false);
		const [before] = await claims(threadId);
		expect(before.state).toBe("running");
		expect(before.lease_until.getTime()).toBeGreaterThan(Date.now() - 5_000); // fresh lease
		await expireSilentTurns();
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "expired", error: "age-bound" });
		expect(await hold(holdIdOf(turn))).toMatchObject({ credits: 0 });
	});

	it("the sweep leaves a live claim alone and skips a thread another transaction holds", async () => {
		const { threadId, turn } = await acceptedFirstTurn();
		await expireSilentTurns();
		expect((await claims(threadId))[0].state).toBe("running");
		await silence(turn.claimId);
		let release = (): void => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holder = getServiceDb().transaction(async (tx) => {
			await tx.select().from(agentThreads).where(eq(agentThreads.id, threadId)).for("update");
			await held;
		});
		// Give the holder time to take the row lock before the sweep runs.
		await new Promise((r) => setTimeout(r, 200));
		await expireSilentTurns();
		expect((await claims(threadId))[0].state).toBe("running");
		release();
		await holder;
		await expireSilentTurns();
		expect((await claims(threadId))[0].state).toBe("expired");
	});

	// ── Continuations and regenerates ────────────────────────────────────────────────────────────

	it("a continuation: the approval output is stored at acceptance, a bad one is 400 with no hold, and a partial one resumes (C4r)", async () => {
		const { user, org } = freshUser();
		const TC = "call-plan-1";
		const u = userMsg("u-plan", "plan the project");
		const proposal: UIMessage = {
			id: "a-plan",
			role: "assistant",
			parts: [
				{ type: "step-start" },
				{
					type: "tool-propose_operation",
					toolCallId: TC,
					state: "input-available",
					input: { operation: "plan_project" },
				},
			],
		};
		const threadId = await seedThread(user, [u, proposal], { revision: 3 });
		const approved = {
			status: "approved",
			operation: "plan_project",
			projectId: randomUUID(),
			environmentId: null,
			jobId: randomUUID(),
			extra: "stripped",
		};
		/** The client's copy of the proposal with an output. */
		const withOutput = (output: unknown): UIMessage => ({
			...proposal,
			parts: [
				{ type: "step-start" },
				{ type: "tool-propose_operation", toolCallId: TC, state: "output-available", input: { operation: "plan_project" }, output },
			],
		});
		const turn: Partial<TurnRequest> & { baseRevision: number } = {
			baseRevision: 3,
			turnId: u.id,
			answerId: proposal.id,
			toolCallIds: [TC],
		};

		const bad = await reserveTurn(submit(user, org, threadId, [u, withOutput({ status: "approved" })], turn));
		expect(bad.outcome).toBe("invalid");
		expect(await ledger(org)).toHaveLength(0);
		expect((await thread(threadId)).revision).toBe(3);

		const cont = accepted(await reserveTurn(submit(user, org, threadId, [u, withOutput(approved)], turn)));
		expect(cont).toMatchObject({ kind: "continue", attemptKey: continuationKey(proposal.id, [TC]), acceptedRevision: 4 });
		const storedA = (await thread(threadId)).messages[1];
		const { extra: _stripped, ...parsed } = approved;
		expect(storedA.parts[1]).toMatchObject({ state: "output-available", output: parsed });
		expect(storedA.parts[1]).not.toMatchObject({ output: { extra: "stripped" } });
		expect(cont.modelInput.at(-1)).toEqual(storedA);

		// The continuation streams, then the client disconnects: the tail is stored partial.
		const continued: UIMessage = {
			...storedA,
			parts: [...storedA.parts, { type: "step-start" }, { type: "text", text: "Planning has sta", state: "streaming" }],
		};
		const fin = await finalizeTurn(cont, { answer: continued, steps: [], partial: true, error: "aborted" });
		expect(fin).toMatchObject({ outcome: "won", state: "answered", answerId: proposal.id, revision: 5 });
		expect((await thread(threadId)).messages).toEqual([u, continued]);

		// Its Retry is the continuation request again, at the current revision: a resume (C4r).
		const resume = accepted(
			await reserveTurn(submit(user, org, threadId, [u, withOutput(approved)], { ...turn, baseRevision: 5 })),
		);
		expect(resume).toMatchObject({ claimId: cont.claimId, attemptNo: 2, acceptedRevision: 5 });
		// The model answers from `a` cut after the approval's step: the stored output kept, the tail dropped.
		expect(resume.modelInput.at(-1)?.parts).toEqual(storedA.parts);
		const [c] = await claims(threadId);
		expect(c).toMatchObject({ state: "running", answer_id: null, partial: false, finished_at: null });
		const resumed: UIMessage = {
			...storedA,
			parts: [...storedA.parts, { type: "step-start" }, { type: "text", text: "Planning has started.", state: "done" }],
		};
		expect(await finalizeTurn(resume, { answer: resumed, steps: STEPS, partial: false })).toMatchObject({
			outcome: "won",
			state: "answered",
			revision: 6,
		});
		expect((await thread(threadId)).messages).toEqual([u, resumed]);
		// A finished continuation is answered.
		expect(
			refusalOf(await reserveTurn(submit(user, org, threadId, [u, withOutput(approved)], { ...turn, baseRevision: 6 }))),
		).toBe("turn-answered");
	});

	it("a continuation answer that does not continue a stores nothing, settles what ran, and logs finalize-answer-mismatch", async () => {
		const TC = "call-plan-m";
		/** An accepted continuation of a stored proposal, in a fresh thread. */
		const acceptedContinuation = async () => {
			const { user, org } = freshUser();
			const u = userMsg("u-plan-m", "plan the project");
			const proposal: UIMessage = {
				id: "a-plan-m",
				role: "assistant",
				parts: [
					{ type: "step-start" },
					{ type: "tool-propose_operation", toolCallId: TC, state: "input-available", input: { operation: "plan_project" } },
				],
			};
			const threadId = await seedThread(user, [u, proposal], { revision: 3 });
			const output = { status: "approved", operation: "plan_project", projectId: randomUUID(), environmentId: null, jobId: randomUUID() };
			const withOutput: UIMessage = {
				...proposal,
				parts: [
					{ type: "step-start" },
					{ type: "tool-propose_operation", toolCallId: TC, state: "output-available", input: { operation: "plan_project" }, output },
				],
			};
			const cont = accepted(
				await reserveTurn(
					submit(user, org, threadId, [u, withOutput], { baseRevision: 3, turnId: u.id, answerId: proposal.id, toolCallIds: [TC] }),
				),
			);
			return { org, threadId, cont };
		};
		const tail: UIMessage["parts"] = [{ type: "step-start" }, { type: "text", text: "Planning has started.", state: "done" }];
		const warnSpy = vi.spyOn(log, "warn");
		try {
			// Another message id, and the right id without the prefix's parts: both a mismatch.
			for (const answer of [
				(prefix: UIMessage): UIMessage => ({ ...prefix, id: "a-other", parts: [...prefix.parts, ...tail] }),
				(prefix: UIMessage): UIMessage => ({ ...prefix, parts: tail }),
			]) {
				const { org, threadId, cont } = await acceptedContinuation();
				const prefix = cont.modelInput.at(-1);
				if (!prefix) throw new Error("no prefix");
				const storedBefore = (await thread(threadId)).messages;
				warnSpy.mockClear();
				const fin = await finalizeTurn(cont, { answer: answer(prefix), steps: STEPS, partial: false });
				expect(fin).toEqual({ outcome: "won", state: "failed" });
				expect(warnSpy).toHaveBeenCalledWith(
					"finalize-answer-mismatch",
					expect.objectContaining({ thread_id: threadId, claim_id: cont.claimId }),
				);
				expect((await thread(threadId)).messages).toEqual(storedBefore);
				expect((await claims(threadId))[0]).toMatchObject({ state: "failed", error: "answer-mismatch", answer_id: null });
				// The model ran: the hold is settled at its real cost, never released to 0.
				const h = await hold(holdIdOf(cont));
				expect(h.settled_at).not.toBeNull();
				expect(h.model).toBe(HAIKU);
				expect(h.credits).toBeGreaterThan(0);
				expect(await ledger(org)).toHaveLength(1);
			}
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("a regenerate answers from T without a, and its finalize replaces a", async () => {
		const { user, org } = freshUser();
		const u = userMsg("u-r", "what failed?");
		const a = answerMsg("a-r1", "Two jobs.");
		const threadId = await seedThread(user, [u, a], { revision: 2 });
		const regen = accepted(
			await reserveTurn({
				...submit(user, org, threadId, [u], { baseRevision: 2 }),
				turn: { trigger: "regenerate-message", turnId: u.id, baseRevision: 2, answerId: a.id },
			}),
		);
		expect(regen).toMatchObject({ kind: "regenerate", attemptKey: `regen:${a.id}`, acceptedRevision: 2 });
		expect(regen.modelInput).toEqual([u]);
		const a2 = answerMsg("a-r2", "Three jobs.");
		expect(await finalizeTurn(regen, { answer: a2, steps: STEPS, partial: false })).toMatchObject({ revision: 3 });
		expect((await thread(threadId)).messages).toEqual([u, a2]);
	});

	it("without hosted billing a claim is taken and no hold is reserved", async () => {
		const key = process.env.STRIPE_SECRET_KEY;
		delete process.env.STRIPE_SECRET_KEY;
		try {
			const { org, threadId, turn } = await acceptedFirstTurn();
			expect(turn.charge).toEqual({ source: "included", credits: 0 });
			expect((await claims(threadId))[0].hold_id).toBeNull();
			expect(await ledger(org)).toHaveLength(0);
			expect(await finalizeTurn(turn, { answer: answerMsg("a-s", "Hi."), steps: [], partial: true })).toMatchObject({
				outcome: "won",
				state: "answered",
			});
			// A partial answer is never floored on self-host: nothing is billed.
			expect((await ledger(org)).reduce((s, r) => s + r.credits, 0)).toBe(0);
		} finally {
			process.env.STRIPE_SECRET_KEY = key;
		}
	});
});
