// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the Elench draft actions against real Postgres (ADR 0001 slice 3, #5742). The unit
// suite (tests/actions/elench-drafts.test.ts) fakes the database, so two things it cannot prove are
// proved here, through the actions themselves, under the app role and its RLS:
//   1. `listDrafts`' 24-hour window is the database's: a discarded draft older than 24 hours is not
//      listed and a newer one is, judged by Postgres' `now() - interval`, not by a fake's clock;
//   2. §4.3's bound holds under concurrency: base-0 saves of different conversations racing at 199
//      active drafts land exactly one row, because the count is serialized per scope. The race is
//      made deterministic rather than hoped for: a service-role transaction holds a SHARE lock on
//      `elench_drafts`, which admits the row lock and the count but blocks every INSERT, until all
//      racers are waiting. Without the per-scope lock every racer has counted 199 by then, and all
//      of them insert; with it, one has counted and the rest wait on the advisory lock.
//
// The actions run under an INJECTED actor (`runWithActor`, the seam the MCP server uses) in the
// community tenancy model (orgId === userId), so the gate's real rate limit, PDP and
// `withActorScope` all run. The PDP authorizes from `grants`, so each actor holds an org-wide
// viewer grant in its personal org. Each case uses its own user, so neither shares a rate-limit
// bucket.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { listDrafts, saveDraft } from "@/app/server/actions/elench-drafts";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import { elenchDrafts, grants, type NewElenchDraft } from "@/lib/db/schema";
import { z } from "zod";
import { describeIfDb } from "./db";

const lockWaits = z.array(z.object({ n: z.number() }));

/** Waiters on `elench_drafts` or on an advisory lock, other than this connection. */
async function waitingRacers(): Promise<number> {
	const res = await getServiceDb().execute(sql`
		select count(*)::int as n from pg_locks
		 where not granted
		   and (locktype = 'advisory' or relation = 'public.elench_drafts'::regclass)`);
	return lockWaits.parse(res)[0]?.n ?? 0;
}

/** Polls until `n` racers wait on a lock, or throws after ~10 s. */
async function untilWaiting(n: number): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if ((await waitingRacers()) >= n) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`only ${await waitingRacers()} of ${n} racers ever waited on a lock`);
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

/** An active draft row of `userId` in its personal org, unanchored. */
function draft(userId: string, over: Partial<NewElenchDraft> = {}): NewElenchDraft {
	return {
		user_id: userId,
		org_id: userId,
		conversation_id: randomUUID(),
		revision: 1,
		status: "active",
		text: "draft",
		mentions: [],
		artifacts: [],
		cell_target: null,
		...over,
	};
}

const instants = z.array(z.object({ at: z.coerce.date() }));

/** A discarded draft's values, discarded `hours` ago by the DATABASE's clock (the one it judges by). */
async function discarded(userId: string, hours: number): Promise<NewElenchDraft> {
	const res = await getServiceDb().execute(
		sql`select now() - make_interval(hours => ${hours}::int) as at`,
	);
	const at = instants.parse(res)[0]?.at;
	if (!at) throw new Error("the database answered no instant");
	return draft(userId, { status: "discarded", discarded_at: at });
}

describeIfDb("the Elench draft actions against Postgres", () => {
	beforeAll(async () => {
		await seedAuthz();
	});

	afterAll(async () => {
		if (users.length > 0) {
			await getServiceDb().delete(elenchDrafts).where(inArray(elenchDrafts.user_id, users));
			await getServiceDb().delete(grants).where(inArray(grants.principal_id, users));
		}
	});

	it("listDrafts lists a draft discarded 23 hours ago and not one discarded 25 hours ago", async () => {
		const actor = await freshActor();
		const active = draft(actor.userId);
		const recent = await discarded(actor.userId, 23);
		const old = await discarded(actor.userId, 25);
		await getServiceDb().insert(elenchDrafts).values([active, recent, old]);

		const out = await runWithActor(actor, () => listDrafts({ projectId: null }));
		if (out.outcome !== "ok") throw new Error(`listDrafts answered ${out.outcome}`);
		const listed = out.drafts.map((d) => d.row.conversationId).sort();
		expect(listed).toEqual([active.conversation_id, recent.conversation_id].sort());
		expect(listed).not.toContain(old.conversation_id);
	});

	it("concurrent base-0 saves at 199 active drafts land exactly one row (§4.3 is serialized)", async () => {
		const actor = await freshActor();
		await getServiceDb()
			.insert(elenchDrafts)
			.values(Array.from({ length: 199 }, () => draft(actor.userId)));

		const racers = 6;
		// The racers' promise is returned WRAPPED: returned bare, the transaction would await it before
		// committing, and the racers wait on the transaction's lock.
		const { running } = await getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`lock table public.elench_drafts in share mode`);
			const all = Promise.all(
				Array.from({ length: racers }, (_, i) =>
					runWithActor(actor, () =>
						saveDraft({
							orgId: actor.orgId,
							projectId: null,
							conversationId: randomUUID(),
							baseRevision: 0,
							content: { text: `racer ${i}`, mentions: [], artifacts: [], cellTarget: null },
							tabId: `tab-${i}`,
						}),
					),
				),
			);
			await untilWaiting(racers);
			return { running: all };
		});
		const outcomes = await running;
		const kinds = outcomes.map((o) => o.outcome).sort();
		expect(kinds).toEqual(["limit", "limit", "limit", "limit", "limit", "saved"]);

		const active = await getServiceDb()
			.select({ id: elenchDrafts.id })
			.from(elenchDrafts)
			.where(and(eq(elenchDrafts.user_id, actor.userId), eq(elenchDrafts.status, "active")));
		expect(active).toHaveLength(200);
	});
});
