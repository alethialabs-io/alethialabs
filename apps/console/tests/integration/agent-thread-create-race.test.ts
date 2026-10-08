// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): `createThread`'s first-turn rewrite against an acceptance that is
// mid-transaction (ADR 0003 §4.2; #5733 review, advisory 1). The rewrite locks the thread row and
// does nothing while the thread has a running claim. That probe is sound only because acceptance
// locks the SAME row before it inserts its claim: a rewrite that reaches the row while an
// acceptance holds it waits, and its probe (a fresh statement under READ COMMITTED) then sees the
// committed claim. Without the lock, or the probe, the rewrite would replace the transcript the
// attempt is answering, and its finalize would come back `moved`.
//
// The interleaving is forced, not hoped for: a test transaction holds an EXCLUSIVE lock on
// `agent_turn_claims`, so the acceptance stops at its first claim statement WITH the thread row
// already locked; the rewrite is started only once the acceptance is seen waiting, and the table lock
// is released only once the rewrite is seen waiting on the row.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { createThread } from "@/app/server/actions/agent";
import { reserveTurn } from "@/lib/agent/turn-claims";
import { runWithActor } from "@/lib/authz/actor-context";
import { getServiceDb } from "@/lib/db";
import { agentThreads, agentTurnClaims, aiUsageLedger } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const USER = randomUUID();

/** Run `fn` as USER in their personal org. */
function asUser<T>(fn: () => Promise<T>): Promise<T> {
	return runWithActor({ userId: USER, orgId: USER }, fn);
}

const countRows = z.array(z.object({ n: z.coerce.number() }));

/** Poll `probe` (a count) until it is at least 1, or fail after ~10 s. */
async function until(probe: () => Promise<number>, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if ((await probe()) > 0) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Backends waiting for a lock on the `agent_turn_claims` relation. */
async function waitingOnClaimsTable(): Promise<number> {
	const res = await getServiceDb().execute(sql`
		select count(*) as n from pg_locks l join pg_class c on c.oid = l.relation
		 where c.relname = 'agent_turn_claims' and not l.granted
	`);
	return countRows.parse(res)[0]?.n ?? 0;
}

/** Backends waiting for a row lock (another transaction's id, or the tuple itself). */
async function waitingOnARow(): Promise<number> {
	const res = await getServiceDb().execute(sql`
		select count(*) as n from pg_locks where not granted and locktype in ('transactionid', 'tuple')
	`);
	return countRows.parse(res)[0]?.n ?? 0;
}

describeIfDb("createThread's rewrite against an acceptance (ADR 0003 §4.2)", () => {
	beforeAll(() => {
		process.env.STRIPE_SECRET_KEY ||= "sk_test_agent_thread_create_race";
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(agentTurnClaims).where(eq(agentTurnClaims.user_id, USER));
		await db.delete(agentThreads).where(inArray(agentThreads.user_id, [USER]));
		await db.delete(aiUsageLedger).where(eq(aiUsageLedger.org_id, USER));
	});

	it("a rewrite that waits on an acceptance's thread lock sees its claim and changes nothing", async () => {
		const turnId = `u-${randomUUID()}`;
		const created = await asUser(() =>
			createThread("deploy staging", undefined, { id: turnId, text: "deploy staging" }),
		);
		expect(created.revision).toBe(1);

		let release = (): void => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gate = getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`lock table agent_turn_claims in exclusive mode`);
			await released;
		});
		await until(async () => {
			const res = await getServiceDb().execute(sql`
				select count(*) as n from pg_locks l join pg_class c on c.oid = l.relation
				 where c.relname = 'agent_turn_claims' and l.mode = 'ExclusiveLock' and l.granted
			`);
			return countRows.parse(res)[0]?.n ?? 0;
		}, "the gate's table lock");

		// The acceptance answers the stored first turn: it locks the thread, then stops at the claims.
		const acceptance = reserveTurn({
			userId: USER,
			orgId: USER,
			threadId: created.id,
			threadKind: "agent",
			projectId: null,
			aiKind: "agent",
			turn: { trigger: "submit-message", turnId, baseRevision: 1 },
			messages: [{ id: turnId, role: "user", parts: [{ type: "text", text: "deploy staging" }] }],
		});
		await until(waitingOnClaimsTable, "the acceptance to wait on agent_turn_claims");

		// A retried first send with EDITED text: without the lock and the probe it would rewrite.
		const rewrite = asUser(() =>
			createThread("deploy prod", undefined, { id: turnId, text: "deploy prod" }),
		);
		await until(waitingOnARow, "the rewrite to wait on the thread row");

		release();
		await gate;
		const [result, rewritten] = await Promise.all([acceptance, rewrite]);
		expect(result.outcome).toBe("accepted");

		const [row] = await getServiceDb().select().from(agentThreads).where(eq(agentThreads.id, created.id));
		expect(row.revision).toBe(1);
		expect(row.title).toBe("deploy staging");
		expect(row.messages).toEqual([
			{ id: turnId, role: "user", parts: [{ type: "text", text: "deploy staging" }] },
		]);
		expect(rewritten.id).toBe(created.id);
		expect(rewritten.messages).toEqual(row.messages);
		const [claim] = await getServiceDb()
			.select()
			.from(agentTurnClaims)
			.where(eq(agentTurnClaims.thread_id, created.id));
		expect(claim).toMatchObject({ state: "running", accepted_revision: 1 });
	});
});
