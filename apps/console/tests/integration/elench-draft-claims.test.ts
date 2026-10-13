// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the draft claim's exclusivity against real Postgres (ADR 0001 slice 4, §3.4: "a
// release and a consume of one claim lock the same row, so exactly one of them happens"). The unit
// suite (tests/actions/elench-draft-claims.test.ts) fakes a sequential database, so it cannot race
// two transactions. Two fences are proved here, under the app role and its RLS:
//   1. the row lock: `consumeDraft` and `releaseClaim` of one claim, racing on two connections,
//      land exactly one end. The race is made deterministic: a service-role transaction holds the
//      row `FOR UPDATE` until both actions wait on it, then lets them go;
//   2. the token: `endClaim` handed a snapshot of a claim that has since been consumed and claimed
//      again under another token (a path that skipped the lock) writes nothing. Without the
//      `claim_token` predicate it would end the NEW claim.
//
// The actions run under an injected actor (`runWithActor`) in the community tenancy model, as in
// tests/integration/elench-drafts-actions.test.ts.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { consumeDraft, releaseClaim } from "@/app/server/actions/elench-drafts";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb, withActorScope } from "@/lib/db";
import { elenchDrafts, grants, type NewElenchDraft } from "@/lib/db/schema";
import { claimOf, endClaim } from "@/lib/elench/draft-claims";
import { describeIfDb } from "./db";

const waits = z.array(z.object({ n: z.number() }));

/** Backends of this database waiting on a lock. */
async function lockWaiters(): Promise<number> {
	const res = await getServiceDb().execute(sql`
		select count(*)::int as n from pg_stat_activity
		 where datname = current_database() and wait_event_type = 'Lock'`);
	return waits.parse(res)[0]?.n ?? 0;
}

/** Polls until `n` backends wait on a lock, or throws after ~10 s. */
async function untilWaiting(n: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if ((await lockWaiters()) >= n) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`only ${await lockWaiters()} of ${n} racers ever waited on a lock`);
}

const users: string[] = [];

/** A fresh personal-org actor with an org-wide viewer grant, remembered for cleanup. */
async function freshActor(): Promise<{ userId: string; orgId: string }> {
	const id = randomUUID();
	users.push(id);
	await getServiceDb().insert(grants).values({
		org_id: id,
		principal_type: "user",
		principal_id: id,
		effect: "allow",
		role_id: BUILTIN_ROLE_IDS.viewer,
		resource_type: "org",
		resource_id: null,
	});
	return { userId: id, orgId: id };
}

/** A later-turn draft of `userId`, `sending` under `token`. */
function sending(userId: string, token: string): NewElenchDraft {
	return {
		user_id: userId,
		org_id: userId,
		conversation_id: randomUUID(),
		revision: 3,
		status: "sending",
		text: "send this",
		mentions: [],
		artifacts: [],
		cell_target: null,
		claim_token: token,
		claim_turn_id: randomUUID(),
		claim_kind: "later",
		claimed_at: new Date(),
	};
}

describeIfDb("the draft claim against Postgres", () => {
	beforeAll(async () => {
		await seedAuthz();
	});

	afterAll(async () => {
		if (users.length > 0) {
			await getServiceDb().delete(elenchDrafts).where(inArray(elenchDrafts.user_id, users));
			await getServiceDb().delete(grants).where(inArray(grants.principal_id, users));
		}
	});

	it("a consume and a release of one claim, racing, land exactly one end", async () => {
		const actor = await freshActor();
		const token = randomUUID();
		const [row] = await getServiceDb()
			.insert(elenchDrafts)
			.values(sending(actor.userId, token))
			.returning();
		if (!row) throw new Error("no row inserted");
		const k = { orgId: actor.orgId, projectId: null, conversationId: row.conversation_id, token };

		// The racers' promise is returned WRAPPED: returned bare, the transaction would await it
		// before committing, and the racers wait on this transaction's lock.
		const { running } = await getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`select 1 from public.elench_drafts where id = ${row.id} for update`);
			const both = Promise.all([
				runWithActor(actor, () => consumeDraft(k)),
				runWithActor(actor, () => releaseClaim({ ...k, error: "502" })),
			]);
			await untilWaiting(2);
			return { running: both };
		});
		const [consumed, released] = await running;
		const ends = [consumed.outcome, released.outcome];
		expect(ends.filter((o) => o === "consumed" || o === "released")).toHaveLength(1);
		expect(ends.filter((o) => o === "not-claimed")).toHaveLength(1);

		const [after] = await getServiceDb().select().from(elenchDrafts).where(eq(elenchDrafts.id, row.id));
		expect(after?.status).toBe("active");
		expect(after?.revision).toBe(4);
		// Whichever end landed, the row shows exactly that one.
		const byEnd = {
			consumed: { text: "", failed_send: null, last_sent: expect.objectContaining({ turnId: row.claim_turn_id }) },
			released: { text: "send this", last_sent: null, failed_send: expect.objectContaining({ error: "502" }) },
		};
		const expected = byEnd[consumed.outcome === "consumed" ? "consumed" : "released"];
		expect(after).toMatchObject(expected);
	});

	it("endClaim with a stale claim never ends the claim that replaced it", async () => {
		const actor = await freshActor();
		const stale = randomUUID();
		const [snapshot] = await getServiceDb()
			.insert(elenchDrafts)
			.values(sending(actor.userId, stale))
			.returning();
		if (!snapshot) throw new Error("no row inserted");
		const staleClaim = claimOf(snapshot);
		if (staleClaim === null) throw new Error("the snapshot holds no claim");

		// Consumed, then claimed again under another token, at the next revisions.
		const live = randomUUID();
		await runWithActor(actor, () =>
			consumeDraft({ orgId: actor.orgId, projectId: null, conversationId: snapshot.conversation_id, token: stale }),
		);
		await getServiceDb()
			.update(elenchDrafts)
			.set({
				status: "sending",
				text: "the next message",
				claim_token: live,
				claim_turn_id: randomUUID(),
				claim_kind: "later",
				claimed_at: new Date(),
				revision: 5,
			})
			.where(eq(elenchDrafts.id, snapshot.id));

		const out = await withActorScope(actor, (tx) =>
			endClaim(tx, actor, snapshot, staleClaim, {
				end: "release",
				turnId: staleClaim.turnId,
				error: "502",
				uncertain: false,
			}),
		);
		expect(out).toBeNull();
		const [after] = await getServiceDb()
			.select()
			.from(elenchDrafts)
			.where(eq(elenchDrafts.id, snapshot.id));
		expect(after).toMatchObject({ status: "sending", claim_token: live, text: "the next message", revision: 5 });
	});
});
