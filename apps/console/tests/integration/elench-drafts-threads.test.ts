// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: drafts and threads together against real Postgres (ADR 0001 slice 5, §5.1, §6.3,
// §13 Q1). The unit suite (tests/actions/elench-start.test.ts) fakes the database, so what only the
// real one can answer is proved here, through the actions themselves, under the app role and RLS:
//   1. `startConversation` stores the first turn and reads `threadRevision` from the inserted row;
//   2. step 5's read names `user_id`: a TEAMMATE's thread whose `org_id` is the page org — which the
//      `owner_all` policy admits — is never read, so it answers `conflict`, not `already-stored`;
//   3. another owner's row under the id, live or tombstone, answers `conflict` (no existence oracle),
//      and the global primary key, not RLS, is what stops the insert;
//   4. an external start racing a base-0 save of the same key loses, and its thread insert rolls back
//      with it (D10f's fence);
//   5. `deleteThread` purges the caller's drafts of the conversation in EVERY org, in its own
//      transaction, and never another user's; `countDraftsOfConversation` counts the same rows;
//   6. a start and a delete of one conversation share one lock order, so they never deadlock.
//
// The actions run under an injected actor (`runWithActor`). Each case uses fresh users and orgs; the
// PDP authorizes from `grants`, so each actor holds an org-wide viewer grant in each org it acts in,
// and, in a team org, the active `member` row the PDP requires there (#5472).

import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { deleteThread } from "@/app/server/actions/agent";
import {
	countDraftsOfConversation,
	listDrafts,
	startConversation,
} from "@/app/server/actions/elench-drafts";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import {
	agentThreads,
	elenchDrafts,
	grants,
	member,
	type NewAgentThread,
	type NewElenchDraft,
	organization,
	user as userTable,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const users: string[] = [];
const orgs: string[] = [];

/** A fresh user id, remembered for cleanup. */
function freshUser(): string {
	const id = randomUUID();
	users.push(id);
	return id;
}

/** Users given a `user` row (team members need one), remembered for cleanup. */
const accounts: string[] = [];

/**
 * A fresh TEAM org whose active members are `members`, remembered for cleanup. Outside the personal
 * scope the PDP honours a grant only for an active `member` row (#5472), so each member gets one.
 */
async function freshOrg(members: string[]): Promise<string> {
	const id = randomUUID();
	orgs.push(id);
	const db = getServiceDb();
	await db.insert(userTable).values(members.map((m) => ({ id: m, email: `it-elench-${m}@example.test` })));
	accounts.push(...members);
	await db.insert(organization).values({ id, name: `it-elench-${id.slice(0, 8)}` });
	await db
		.insert(member)
		.values(members.map((m) => ({ id: randomUUID(), organizationId: id, userId: m, role: "member" })));
	return id;
}

/** An org-wide viewer grant for `userId` in `orgId`, so the PDP admits the scope there. */
async function grantViewer(userId: string, orgId: string): Promise<void> {
	await getServiceDb().insert(grants).values({
		org_id: orgId,
		principal_type: "user",
		principal_id: userId,
		effect: "allow",
		role_id: BUILTIN_ROLE_IDS.viewer,
		resource_type: "org",
		resource_id: null,
	});
}

/** The caller's first-turn claim on `conversationId` in `orgId`, under `token` for `turnId`. */
function firstClaim(
	userId: string,
	orgId: string,
	conversationId: string,
	token: string,
	turnId: string,
): NewElenchDraft {
	return {
		user_id: userId,
		org_id: orgId,
		conversation_id: conversationId,
		revision: 2,
		status: "sending",
		text: " deploy staging\n",
		mentions: [],
		artifacts: [],
		cell_target: null,
		claim_token: token,
		claim_turn_id: turnId,
		claim_kind: "first",
		claimed_at: new Date(),
	};
}

/** A plain active draft of `userId` in `orgId` for `conversationId`. */
function activeDraft(userId: string, orgId: string, conversationId: string): NewElenchDraft {
	return {
		user_id: userId,
		org_id: orgId,
		conversation_id: conversationId,
		revision: 1,
		status: "active",
		text: "unsent words",
		mentions: [],
		artifacts: [],
		cell_target: null,
	};
}

/** A live thread row holding one user turn, as the chat stores it. */
function threadOf(
	id: string,
	userId: string,
	orgId: string,
	turnId: string,
	over: Partial<NewAgentThread> = {},
): NewAgentThread {
	const turn: UIMessage = { id: turnId, role: "user", parts: [{ type: "text", text: "theirs" }] };
	return { id, user_id: userId, org_id: orgId, title: "theirs", messages: [turn], ...over };
}

/** The draft rows the SERVICE role sees for a conversation, as `user/org` pairs. */
async function draftsOf(conversationId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ user: elenchDrafts.user_id, org: elenchDrafts.org_id })
		.from(elenchDrafts)
		.where(eq(elenchDrafts.conversation_id, conversationId));
	return rows.map((r) => `${r.user}/${r.org}`).sort();
}

/** The caller's draft row for a key, read on the service role. */
async function draftAt(userId: string, orgId: string, conversationId: string) {
	const [row] = await getServiceDb()
		.select()
		.from(elenchDrafts)
		.where(
			and(
				eq(elenchDrafts.user_id, userId),
				eq(elenchDrafts.org_id, orgId),
				eq(elenchDrafts.conversation_id, conversationId),
			),
		);
	return row;
}

/** The thread rows under an id, read on the service role. */
async function threadsAt(id: string) {
	return getServiceDb().select().from(agentThreads).where(eq(agentThreads.id, id));
}

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

describeIfDb("Elench drafts and threads against Postgres", () => {
	beforeAll(async () => {
		await seedAuthz();
	});

	afterAll(async () => {
		if (users.length > 0) {
			await getServiceDb().delete(elenchDrafts).where(inArray(elenchDrafts.user_id, users));
			await getServiceDb().delete(agentThreads).where(inArray(agentThreads.user_id, users));
			await getServiceDb().delete(grants).where(inArray(grants.principal_id, users));
		}
		if (orgs.length > 0) {
			await getServiceDb().delete(member).where(inArray(member.organizationId, orgs));
			await getServiceDb().delete(organization).where(inArray(organization.id, orgs));
		}
		if (accounts.length > 0) await getServiceDb().delete(userTable).where(inArray(userTable.id, accounts));
	});

	it("a composer start stores the trimmed first turn and answers the inserted row's revision", async () => {
		const user = freshUser();
		await grantViewer(user, user);
		const conversation = randomUUID();
		const token = randomUUID();
		const turnId = randomUUID();
		await getServiceDb().insert(elenchDrafts).values(firstClaim(user, user, conversation, token, turnId));

		const out = await runWithActor({ userId: user, orgId: user }, () =>
			startConversation({
				orgId: user,
				projectId: null,
				conversationId: conversation,
				origin: "composer",
				turnId,
				token,
				title: "",
			}),
		);
		const [thread] = await threadsAt(conversation);
		expect(out).toEqual({ outcome: "created", revision: 3, threadRevision: thread?.revision });
		expect(thread).toMatchObject({
			user_id: user,
			org_id: user,
			project_id: null,
			title: "deploy staging",
			messages: [
				{
					id: turnId,
					role: "user",
					parts: [{ type: "text", text: "deploy staging" }],
					metadata: { mentions: [], cellTarget: null },
				},
			],
		});
		expect(await draftAt(user, user, conversation)).toMatchObject({
			status: "active",
			revision: 3,
			text: "",
			claim_token: null,
			thread_seen: true,
		});
	});

	// §4 step 5: `owner_all` admits every agent_threads row whose org_id is the page org, so a
	// teammate's thread there is visible to the policy. Only the explicit `user_id` predicate keeps it
	// out — and if it were read, its first turn (this very turn id) would answer `already-stored` and
	// consume the caller's words into a thread they cannot open.
	it("a teammate's thread whose org_id is the page org is never read: conflict, and the words are released", async () => {
		const user = freshUser();
		const mate = freshUser();
		const org = await freshOrg([user, mate]);
		await grantViewer(user, org);
		await grantViewer(mate, org);
		const conversation = randomUUID();
		const token = randomUUID();
		const turnId = randomUUID();
		await getServiceDb().insert(agentThreads).values(threadOf(conversation, mate, org, turnId));
		await getServiceDb().insert(elenchDrafts).values(firstClaim(user, org, conversation, token, turnId));

		const actor = { userId: user, orgId: org };
		const out = await runWithActor(actor, () =>
			startConversation({
				orgId: org,
				projectId: null,
				conversationId: conversation,
				origin: "composer",
				turnId,
				token,
				title: "",
			}),
		);
		expect(out).toEqual({ outcome: "conflict", revision: 3 });
		expect(await draftAt(user, org, conversation)).toMatchObject({
			status: "active",
			text: " deploy staging\n",
			failed_send: expect.objectContaining({ turnId, error: "conflict" }),
		});
		// The teammate's thread is untouched, and no other action sees it either.
		const [theirs] = await threadsAt(conversation);
		expect(theirs).toMatchObject({ user_id: mate, title: "theirs" });
		const listed = await runWithActor(actor, () => listDrafts({ projectId: null }));
		if (listed.outcome !== "ok") throw new Error(`listDrafts answered ${listed.outcome}`);
		const entry = listed.drafts.find((d) => d.row.conversationId === conversation);
		expect(entry?.thread).toEqual({ status: "none", firstTurnId: null, hasTurn: false });
	});

	// §13 Q1: a squatted id is a denial of service, never a read. Another owner's row — live or a
	// tombstone — answers exactly what a mismatch on one's own row answers.
	it("another owner's live row and another owner's tombstone both answer conflict", async () => {
		const user = freshUser();
		const stranger = freshUser();
		await grantViewer(user, user);
		for (const status of ["active", "deleted"]) {
			const conversation = randomUUID();
			const token = randomUUID();
			const turnId = randomUUID();
			await getServiceDb()
				.insert(agentThreads)
				.values(threadOf(conversation, stranger, stranger, turnId, { status }));
			await getServiceDb().insert(elenchDrafts).values(firstClaim(user, user, conversation, token, turnId));

			const out = await runWithActor({ userId: user, orgId: user }, () =>
				startConversation({
					orgId: user,
					projectId: null,
					conversationId: conversation,
					origin: "composer",
					turnId,
					token,
					title: "",
				}),
			);
			expect({ status, out }).toEqual({ status, out: { outcome: "conflict", revision: 3 } });
			expect(await draftAt(user, user, conversation)).toMatchObject({ status: "active", text: " deploy staging\n" });
			const rows = await threadsAt(conversation);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ user_id: stranger, status });
		}
	});

	// B2' (D10f): the fencing save and an external start of one key can never both commit.
	it("an external start with no draft row loses to a base-0 save that inserted first, and its thread insert rolls back", async () => {
		const user = freshUser();
		await grantViewer(user, user);
		const conversation = randomUUID();
		const turnId = randomUUID();

		// The save's transaction inserts the key and holds it uncommitted while the start runs: the
		// start's lock read sees no row, its thread insert succeeds, and its draft insert then waits
		// on the key. The save commits; the start's insert writes nothing. The racer's promise is
		// returned WRAPPED: returned bare, the transaction would await it before committing.
		const { running } = await getServiceDb().transaction(async (tx) => {
			await tx.insert(elenchDrafts).values({ ...activeDraft(user, user, conversation), text: "the prompt" });
			const start = runWithActor({ userId: user, orgId: user }, () =>
				startConversation({
					orgId: user,
					projectId: null,
					conversationId: conversation,
					origin: "external",
					turnId,
					revision: 0,
					text: "the prompt",
					mentions: [],
					cellTarget: { x: 1, y: 2 },
					title: "",
				}),
			);
			await untilWaiting(1);
			return { running: start };
		});
		const out = await running;
		expect(out).toMatchObject({
			outcome: "draft-conflict",
			row: { revision: 1, content: { text: "the prompt" } },
			thread: { status: "none", firstTurnId: null },
		});
		expect(await threadsAt(conversation)).toEqual([]);
	});

	// #5772 review: one lock order. `startConversation` locks the draft row, then inserts under the
	// thread id; `deleteThread` purges the drafts, then deletes the thread and writes its tombstone.
	// Made deterministic as the claim race is: a service-role transaction holds the draft row while
	// the START queues on it first and the DELETE second. On release the start holds the draft row
	// and goes for the thread id. With the delete's old order (thread first) the delete would already
	// hold the thread row and its tombstone, the start would wait on them, the delete would wait on the
	// draft row: a deadlock, which Postgres breaks by aborting one of them. With one order the delete
	// has touched nothing but its queue slot, so the start finishes (`conflict`: the live thread's
	// first turn is another) and the delete then purges and tombstones.
	it("a start and a delete of one conversation take the same lock order and both complete", async () => {
		const user = freshUser();
		await grantViewer(user, user);
		const conversation = randomUUID();
		const token = randomUUID();
		const turnId = randomUUID();
		await getServiceDb()
			.insert(agentThreads)
			.values(threadOf(conversation, user, user, randomUUID(), { title: "mine" }));
		const [claimRow] = await getServiceDb()
			.insert(elenchDrafts)
			.values(firstClaim(user, user, conversation, token, turnId))
			.returning();
		if (!claimRow) throw new Error("no draft inserted");
		const actor = { userId: user, orgId: user };

		const { racers } = await getServiceDb().transaction(async (tx) => {
			await tx.execute(sql`select 1 from public.elench_drafts where id = ${claimRow.id} for update`);
			const start = runWithActor(actor, () =>
				startConversation({
					orgId: user,
					projectId: null,
					conversationId: conversation,
					origin: "composer",
					turnId,
					token,
					title: "",
				}),
			);
			await untilWaiting(1);
			const del = runWithActor(actor, () => deleteThread(conversation));
			await untilWaiting(2);
			return { racers: Promise.allSettled([start, del]) };
		});
		const [started, deleted] = await racers;
		expect(started).toEqual({ status: "fulfilled", value: { outcome: "conflict", revision: 3 } });
		expect(deleted).toEqual({ status: "fulfilled", value: { purged: 1 } });
		expect(await draftsOf(conversation)).toEqual([]);
		const [tombstone] = await threadsAt(conversation);
		expect(tombstone).toMatchObject({ user_id: user, status: "deleted" });
	});

	// §6.3, #5464 AC16, G6: one conversation id is a draft per org; deleting the thread removes all
	// of the caller's, and none of anybody else's.
	it("deleteThread purges the user's drafts in orgs A and B, and never another user's", async () => {
		const user = freshUser();
		const stranger = freshUser();
		const orgB = await freshOrg([user]);
		await grantViewer(user, user);
		await grantViewer(user, orgB);
		const conversation = randomUUID();
		await getServiceDb()
			.insert(agentThreads)
			.values(threadOf(conversation, user, user, randomUUID(), { title: "mine" }));
		await getServiceDb()
			.insert(elenchDrafts)
			.values([
				activeDraft(user, user, conversation),
				activeDraft(user, orgB, conversation),
				activeDraft(stranger, user, conversation),
			]);

		// The confirm's count: both of the caller's orgs, read from either.
		expect(
			await runWithActor({ userId: user, orgId: orgB }, () => countDraftsOfConversation({ id: conversation })),
		).toEqual({ outcome: "ok", count: 2, orgs: 2 });

		const out = await runWithActor({ userId: user, orgId: user }, () => deleteThread(conversation));
		expect(out).toEqual({ purged: 2 });
		expect(await draftsOf(conversation)).toEqual([`${stranger}/${user}`]);
		const [tombstone] = await threadsAt(conversation);
		expect(tombstone).toMatchObject({ user_id: user, status: "deleted", messages: [] });
		expect(
			await runWithActor({ userId: user, orgId: user }, () => countDraftsOfConversation({ id: conversation })),
		).toEqual({ outcome: "ok", count: 0, orgs: 0 });
	});
});
