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
// is released only once the rewrite is seen waiting on the row. Both probes are scoped to the backend
// that blocks the waiter (the gate's, then the acceptance's), so another test file's lock waits cannot
// satisfy them.

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
const pidRows = z.array(z.object({ pid: z.coerce.number() }));

/** Poll `probe` until it returns a value, or fail after ~10 s. */
async function until<T>(probe: () => Promise<T | null>, what: string): Promise<T> {
	for (let i = 0; i < 200; i++) {
		const found = await probe();
		if (found !== null) return found;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/**
 * The backend waiting for a lock on the `agent_turn_claims` relation BEHIND the gate's backend
 * (`gatePid`), or null. Scoped to that blocker, so another test file's waiter cannot satisfy it.
 */
async function waitingOnClaimsTableBehind(gatePid: number): Promise<number | null> {
	const res = await getServiceDb().execute(sql`
		select l.pid from pg_locks l join pg_class c on c.oid = l.relation
		 where c.relname = 'agent_turn_claims' and not l.granted
		   and ${gatePid}::int = any(pg_blocking_pids(l.pid))
	`);
	return pidRows.parse(res)[0]?.pid ?? null;
}

/**
 * Whether a backend waits for a row lock (another transaction's id, or the tuple itself) held by the
 * acceptance's backend (`acceptancePid`). Scoped to that holder, for the same reason.
 */
async function waitingOnARowHeldBy(acceptancePid: number): Promise<true | null> {
	const res = await getServiceDb().execute(sql`
		select count(*) as n from pg_locks
		 where not granted and locktype in ('transactionid', 'tuple')
		   and ${acceptancePid}::int = any(pg_blocking_pids(pid))
	`);
	return (countRows.parse(res)[0]?.n ?? 0) > 0 ? true : null;
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
		let gateLocked = (_pid: number): void => {};
		const gatePidP = new Promise<number>((resolve) => {
			gateLocked = resolve;
		});
		const gate = getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`lock table agent_turn_claims in exclusive mode`);
			const me = pidRows.parse(await tx.execute(sql`select pg_backend_pid() as pid`))[0];
			if (!me) throw new Error("pg_backend_pid() returned no row");
			gateLocked(me.pid);
			await released;
		});
		const gatePid = await gatePidP;

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
		const acceptancePid = await until(
			() => waitingOnClaimsTableBehind(gatePid),
			"the acceptance to wait on agent_turn_claims behind the gate",
		);

		// A retried first send with EDITED text: without the lock and the probe it would rewrite.
		const rewrite = asUser(() =>
			createThread("deploy prod", undefined, { id: turnId, text: "deploy prod" }),
		);
		await until(() => waitingOnARowHeldBy(acceptancePid), "the rewrite to wait on the acceptance's thread row");

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
