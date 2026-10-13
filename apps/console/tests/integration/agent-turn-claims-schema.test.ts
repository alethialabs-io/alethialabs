// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the `agent_turn_claims` schema, its RLS, and the thread fields of ADR 0003 slice 1
// (`docs/adr/0003-chat-turn-answered-and-billed-once.md` §4.1-§4.3, #5730). Real Postgres.
//
// Three halves, each asking the database rather than the schema file:
//   1. the catalog — every column, no foreign key on `thread_id`, both unique constraints, the three
//      partial indexes, the check, RLS ENABLEd and the `owner_only` policy as deployed;
//   2. the constraints as BEHAVIOUR — a duplicate key, a second running attempt and an `answered`
//      row without an answer are each refused by Postgres, and a claim on a thread id that has no row
//      is accepted (the missing FK is the point, §4.3);
//   3. the actions — `getThread` returns `revision` and `inFlight` (a silent lease excluded), and
//      `createThread`'s first-turn rewrite bumps `revision` and does nothing while a claim runs.
//
// The app-role cases need a distinct `alethia_app` connection (ALETHIA_APP_DATABASE_URL): the
// migration role is BYPASSRLS, so an isolation assertion run through it passes by construction.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { createThread, getThread } from "@/app/server/actions/agent";
import { runWithActor } from "@/lib/authz/actor-context";
import { getServiceDb, withOwnerScope, withScope } from "@/lib/db";
import {
	agentThreads,
	agentTurnClaims,
} from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText } from "./db";

// Community tenancy: orgId === userId (personal org).
const OWNER = randomUUID();
const OTHER = randomUUID();

/** Run `fn` as `userId` in their personal org. */
function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
	return runWithActor({ userId, orgId: userId }, fn);
}

/** Insert a thread for `userId` on the service role and return its id. */
async function seedThread(userId: string, messages: { id: string; text: string }[] = []): Promise<string> {
	const [row] = await getServiceDb()
		.insert(agentThreads)
		.values({
			user_id: userId,
			org_id: userId,
			title: "seeded",
			messages: messages.map((m) => ({
				id: m.id,
				role: "user" as const,
				parts: [{ type: "text" as const, text: m.text }],
			})),
		})
		.returning({ id: agentThreads.id });
	return row.id;
}

/** A claim insert, whose timestamps may be SQL (`now()`) so they are the database's clock. */
type ClaimValues = PgInsertValue<typeof agentTurnClaims>;

/** A claim row's values, `running` with a fresh 90 s lease unless overridden. */
function claim(threadId: string, userId: string, over: Partial<ClaimValues> = {}): ClaimValues {
	return {
		thread_id: threadId,
		user_id: userId,
		turn_id: `m-${randomUUID()}`,
		attempt_key: "answer",
		state: "running",
		token: randomUUID(),
		billing_org_id: userId,
		accepted_revision: 1,
		lease_until: sql`now() + interval '90 seconds'`,
		accepted_at: sql`now()`,
		...over,
	};
}

/** Insert a claim on the service role (as acceptance does) and return its id. */
async function seedClaim(values: ClaimValues): Promise<string> {
	const [row] = await getServiceDb()
		.insert(agentTurnClaims)
		.values(values)
		.returning({ id: agentTurnClaims.id });
	return row.id;
}

const columnRows = z.array(
	z.object({
		name: z.string(),
		type: z.string(),
		nullable: z.enum(["YES", "NO"]),
		dflt: z.string().nullable(),
	}),
);
const nameRows = z.array(z.object({ name: z.string(), def: z.string() }));
const rlsRows = z.array(z.object({ rls: z.boolean(), forced: z.boolean() }));
const policyRows = z.array(
	z.object({
		name: z.string(),
		cmd: z.string(),
		qual: z.string().nullable(),
		check: z.string().nullable(),
	}),
);

/** The columns of `table` as Postgres reports them, keyed by name. */
async function columns(table: string): Promise<Map<string, z.infer<typeof columnRows>[number]>> {
	const res = await getServiceDb().execute(sql`
		select column_name as name, data_type as type, is_nullable as nullable, column_default as dflt
		  from information_schema.columns
		 where table_schema = 'public' and table_name = ${table}
	`);
	return new Map(columnRows.parse(res).map((c) => [c.name, c]));
}

describeIfDb("agent_turn_claims: schema, RLS and the thread fields (ADR 0003 slice 1)", () => {
	afterAll(async () => {
		await getServiceDb()
			.delete(agentTurnClaims)
			.where(inArray(agentTurnClaims.user_id, [OWNER, OTHER]));
		await getServiceDb()
			.delete(agentThreads)
			.where(inArray(agentThreads.user_id, [OWNER, OTHER]));
	});

	// ── 1. The catalog ──────────────────────────────────────────────────────────────────────────

	it("has every §4.1 column with its type and nullability", async () => {
		const cols = await columns("agent_turn_claims");
		const expected: [string, string, "YES" | "NO"][] = [
			["id", "uuid", "NO"],
			["thread_id", "uuid", "NO"],
			["user_id", "uuid", "NO"],
			["turn_id", "text", "NO"],
			["attempt_key", "text", "NO"],
			["state", "text", "NO"],
			["token", "uuid", "NO"],
			["attempt_no", "integer", "NO"],
			["billing_org_id", "uuid", "NO"],
			["project_id", "uuid", "YES"],
			["hold_id", "uuid", "YES"],
			["accepted_revision", "integer", "NO"],
			["answer_id", "text", "YES"],
			["partial", "boolean", "NO"],
			["error", "text", "YES"],
			["lease_until", "timestamp with time zone", "NO"],
			["accepted_at", "timestamp with time zone", "NO"],
			["created_at", "timestamp with time zone", "NO"],
			["updated_at", "timestamp with time zone", "NO"],
			["finished_at", "timestamp with time zone", "YES"],
		];
		expect([...cols.keys()].sort()).toEqual(expected.map(([n]) => n).sort());
		for (const [name, type, nullable] of expected) {
			expect({ name, ...cols.get(name) }).toMatchObject({ name, type, nullable });
		}
		expect(cols.get("attempt_no")?.dflt).toBe("1");
		expect(cols.get("partial")?.dflt).toBe("false");
	});

	it("adds agent_threads.revision (not null, default 1) and billing_org_id (nullable uuid)", async () => {
		const cols = await columns("agent_threads");
		expect(cols.get("revision")).toMatchObject({ type: "integer", nullable: "NO", dflt: "1" });
		expect(cols.get("billing_org_id")).toMatchObject({ type: "uuid", nullable: "YES", dflt: null });
	});

	it("has no foreign key, both unique constraints, the three partial indexes and the check", async () => {
		const cons = nameRows.parse(
			await getServiceDb().execute(sql`
				select conname as name, contype::text || ' ' || pg_get_constraintdef(oid) as def
				  from pg_constraint
				 where conrelid = 'public.agent_turn_claims'::regclass
			`),
		);
		// §4.3: a claim outlives its thread's delete, so thread_id carries NO foreign key.
		expect(cons.filter((c) => c.def.startsWith("f "))).toEqual([]);
		const defs = cons.map((c) => c.def);
		expect(defs).toContain("u UNIQUE (thread_id, turn_id, attempt_key)");
		expect(defs).toContain(
			"c CHECK (((state = 'answered'::text) = (answer_id IS NOT NULL)))",
		);

		const idx = nameRows.parse(
			await getServiceDb().execute(sql`
				select indexname as name, indexdef as def from pg_indexes
				 where schemaname = 'public' and tablename = 'agent_turn_claims'
			`),
		);
		const where = idx.map((i) => i.def.replace(/^.* USING /, ""));
		expect(where).toEqual(
			expect.arrayContaining([
				"btree (thread_id) WHERE (state = 'running'::text)",
				"btree (lease_until) WHERE (state = 'running'::text)",
				"btree (hold_id) WHERE (state = 'running'::text)",
				"btree (finished_at) WHERE (state <> 'running'::text)",
			]),
		);
		// The one-running-per-thread index is UNIQUE; the other three are plain.
		expect(idx.find((i) => i.def.includes("btree (thread_id) WHERE"))?.def).toMatch(/^CREATE UNIQUE INDEX/);
	});

	it("RLS is enabled on agent_turn_claims (and not forced, as no table here is)", async () => {
		const [row] = rlsRows.parse(
			await getServiceDb().execute(sql`
				select relrowsecurity as rls, relforcerowsecurity as forced
				  from pg_class where oid = 'public.agent_turn_claims'::regclass
			`),
		);
		expect(row).toEqual({ rls: true, forced: false });
	});

	it("carries exactly the owner_only policy: every command, the owner GUC only, no org arm", async () => {
		const rows = policyRows.parse(
			await getServiceDb().execute(sql`
				select polname as name, polcmd::text as cmd,
				       pg_get_expr(polqual, polrelid) as qual,
				       pg_get_expr(polwithcheck, polrelid) as "check"
				  from pg_policy where polrelid = 'public.agent_turn_claims'::regclass
			`),
		);
		expect(rows.map((r) => r.name)).toEqual(["owner_only"]);
		const [p] = rows;
		expect(p.cmd).toBe("*");
		const owner = /^\(user_id = \(current_setting\('app\.current_owner'::text, true\)\)::uuid\)$/;
		expect(p.qual).toMatch(owner);
		expect(p.check).toMatch(owner);
	});

	// ── 2. The constraints, as behaviour ───────────────────────────────────────────────────────

	it("refuses a second row for one (thread, turn, attempt key)", async () => {
		const thread = await seedThread(OWNER);
		const first = claim(thread, OWNER, { state: "failed", lease_until: sql`now()` });
		await seedClaim(first);
		const text = await refusalText(() =>
			seedClaim({ ...first, token: randomUUID(), state: "expired" }),
		);
		expect(text).toMatch(/uq_agent_turn_claims_key/);
	});

	it("refuses a second running attempt on one thread, and allows it once the first has ended", async () => {
		const thread = await seedThread(OWNER);
		const first = await seedClaim(claim(thread, OWNER));
		const text = await refusalText(() => seedClaim(claim(thread, OWNER)));
		expect(text).toMatch(/uq_agent_turn_claims_one_running/);

		await getServiceDb()
			.update(agentTurnClaims)
			.set({ state: "failed", error: "provider", finished_at: sql`now()` })
			.where(eq(agentTurnClaims.id, first));
		await expect(seedClaim(claim(thread, OWNER))).resolves.toEqual(expect.any(String));
	});

	it("refuses an answered claim without an answer id, and an answer id on any other state", async () => {
		const thread = await seedThread(OWNER);
		const noAnswer = await refusalText(() =>
			seedClaim(claim(thread, OWNER, { state: "answered", lease_until: sql`now()` })),
		);
		expect(noAnswer).toMatch(/agent_turn_claims_answered_has_answer/);
		const strayAnswer = await refusalText(() =>
			seedClaim(claim(thread, OWNER, { answer_id: "a-1" })),
		);
		expect(strayAnswer).toMatch(/agent_turn_claims_answered_has_answer/);
		await expect(
			seedClaim(claim(thread, OWNER, { state: "answered", answer_id: "a-2", lease_until: sql`now()` })),
		).resolves.toEqual(expect.any(String));
	});

	it("accepts a claim whose thread row does not exist: no FK, so a claim outlives its thread", async () => {
		const gone = randomUUID();
		await expect(seedClaim(claim(gone, OWNER))).resolves.toEqual(expect.any(String));
	});

	// ── 3. RLS through the app role ────────────────────────────────────────────────────────────

	it.skipIf(!APP_ROLE_DISTINCT)(
		"the policy shows a claim to its owner, in any org scope, and to nobody else",
		async () => {
			const thread = await seedThread(OWNER);
			const id = await seedClaim(claim(thread, OWNER));
			/** How many rows the app role shows for the claim under this scope. */
			const seen = async (ownerId: string, orgId: string): Promise<number> =>
				(
					await withScope({ ownerId, orgId }, (tx) =>
						tx
							.select({ id: agentTurnClaims.id })
							.from(agentTurnClaims)
							.where(eq(agentTurnClaims.id, id)),
					)
				).length;
			expect(await seen(OWNER, OWNER)).toBe(1);
			// No org arm: the owner driving the thread from another org's tab sees the same row (§4.3).
			expect(await seen(OWNER, randomUUID())).toBe(1);
			// Another user sees nothing — even scoped to the owner's own org, since there is no org arm.
			expect(await seen(OTHER, OTHER)).toBe(0);
			expect(await seen(OTHER, OWNER)).toBe(0);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a claim on another user's thread id is refused: no read, no write, and getThread is null",
		async () => {
			const theirs = await seedThread(OTHER, [{ id: `m-${randomUUID()}`, text: "theirs" }]);
			const theirClaim = await seedClaim(claim(theirs, OTHER));

			// The other user's thread and its running claim are invisible to OWNER.
			expect(await as(OWNER, () => getThread(theirs))).toBeNull();
			const seen = await withOwnerScope(OWNER, (tx) =>
				tx
					.select({ id: agentTurnClaims.id })
					.from(agentTurnClaims)
					.where(eq(agentTurnClaims.thread_id, theirs)),
			);
			expect(seen).toEqual([]);

			// A claim written under OWNER's scope naming the other user is refused by WITH CHECK.
			const insert = await refusalText(() =>
				withOwnerScope(OWNER, (tx) => tx.insert(agentTurnClaims).values(claim(theirs, OTHER))),
			);
			expect(insert).toMatch(/row-level security/);

			// Their claim cannot be ended or removed from OWNER's scope: both match no row.
			const ended = await withOwnerScope(OWNER, (tx) =>
				tx
					.update(agentTurnClaims)
					.set({ state: "expired", finished_at: sql`now()` })
					.where(eq(agentTurnClaims.id, theirClaim))
					.returning({ id: agentTurnClaims.id }),
			);
			expect(ended).toEqual([]);
			const removed = await withOwnerScope(OWNER, (tx) =>
				tx
					.delete(agentTurnClaims)
					.where(eq(agentTurnClaims.id, theirClaim))
					.returning({ id: agentTurnClaims.id }),
			);
			expect(removed).toEqual([]);
			const [still] = await getServiceDb()
				.select({ state: agentTurnClaims.state })
				.from(agentTurnClaims)
				.where(eq(agentTurnClaims.id, theirClaim));
			expect(still.state).toBe("running");
		},
	);

	// ── 4. The actions ─────────────────────────────────────────────────────────────────────────

	it("getThread returns revision and inFlight, and no inFlight for a silent claim", async () => {
		const thread = await seedThread(OWNER, [{ id: `m-${randomUUID()}`, text: "deploy" }]);
		const idle = await as(OWNER, () => getThread(thread));
		expect(idle).toMatchObject({ id: thread, revision: 1, inFlight: null });

		const turnId = `m-${randomUUID()}`;
		const id = await seedClaim(claim(thread, OWNER, { turn_id: turnId }));
		const busy = await as(OWNER, () => getThread(thread));
		expect(busy?.inFlight?.turnId).toBe(turnId);
		expect(busy?.inFlight?.since).toBeInstanceOf(Date);

		// A dead process stopped renewing: the lease is silent, so the claim is not shown in flight.
		await getServiceDb()
			.update(agentTurnClaims)
			.set({ lease_until: sql`now() - interval '1 second'` })
			.where(eq(agentTurnClaims.id, id));
		expect((await as(OWNER, () => getThread(thread)))?.inFlight).toBeNull();

		// An ended claim is not in flight either, whatever its lease.
		await getServiceDb()
			.update(agentTurnClaims)
			.set({ state: "failed", lease_until: sql`now() + interval '90 seconds'`, finished_at: sql`now()` })
			.where(eq(agentTurnClaims.id, id));
		expect((await as(OWNER, () => getThread(thread)))?.inFlight).toBeNull();
	});

	it("createThread's rewrite bumps revision; it does nothing while a claim runs", async () => {
		const turnId = `m-${randomUUID()}`;
		const created = await as(OWNER, () =>
			createThread("first", undefined, { id: turnId, text: "first" }),
		);
		expect(created.revision).toBe(1);

		// A lost response retried with edited text: the rewrite is a write to messages, so +1.
		const retried = await as(OWNER, () =>
			createThread("edited", undefined, { id: turnId, text: "edited" }),
		);
		expect(retried.id).toBe(created.id);
		expect(retried.revision).toBe(2);

		// An attempt is now answering the turn: the retry must not touch the transcript.
		await seedClaim(claim(created.id, OWNER, { turn_id: turnId, accepted_revision: 2 }));
		const during = await as(OWNER, () =>
			createThread("edited again", undefined, { id: turnId, text: "edited again" }),
		);
		expect(during.id).toBe(created.id);
		expect(during.revision).toBe(2);
		const [row] = await getServiceDb()
			.select({ revision: agentThreads.revision, messages: agentThreads.messages, title: agentThreads.title })
			.from(agentThreads)
			.where(eq(agentThreads.id, created.id));
		expect(row.revision).toBe(2);
		expect(row.title).toBe("edited");
		expect(row.messages[0]?.parts).toEqual([{ type: "text", text: "edited" }]);
	});
});
