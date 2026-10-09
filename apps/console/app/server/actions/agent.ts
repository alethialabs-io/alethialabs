"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { and, desc, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/owner";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";
import { THREAD_DELETED, threadTitle } from "@/lib/agent/transcript-save";
import { withOwnerScope } from "@/lib/db";
import { type AgentThread, agentThreads, agentTurnClaims } from "@/lib/db/schema";

/** A row that is a thread, not the tombstone of a deleted one (`deleteThread`). */
const live = ne(agentThreads.status, THREAD_DELETED);

/**
 * The user turn that opens a conversation, as the client sends it: the id the chat gives the
 * message (so the stored copy and the in-memory one are the same message) and its text. Only
 * the text is accepted — the stored `UIMessage` is built here, never taken from the client.
 */
const firstTurnSchema = z.object({
	id: z.string().min(1).max(128),
	// Stored verbatim (no trim): the in-memory message is not trimmed either. The cap is the
	// one the chat routes and the composer enforce, so a turn this rejects is one the route
	// would have refused anyway — the composer stops it before it gets here.
	text: z
		.string()
		.max(MAX_USER_MESSAGE_CHARS)
		.refine((t) => t.trim().length > 0, "A first turn needs text"),
});

/** The first user turn of a new thread (see `firstTurnSchema`). */
export type FirstTurn = z.infer<typeof firstTurnSchema>;

/** The turn a live attempt is answering right now (ADR 0003 §4.2): its id and when it was accepted. */
export interface ThreadInFlight {
	turnId: string;
	since: Date;
}

/** A thread as `getThread` loads it: the row (with its `revision`) and the turn being answered, if any. */
export type LoadedThread = AgentThread & { inFlight: ThreadInFlight | null };

/**
 * Create a new owner-scoped agent chat thread. `projectId` scopes it to a project
 * (the project assistant); omitted → an org-level conversation (the general agent).
 *
 * `firstTurn`, when given, is STORED as the thread's transcript in the same insert. The
 * assistant reply is persisted only by the streaming route's `onFinish`, which never runs
 * when the turn fails (AI not configured, budget, provider error) — so without this the
 * row kept zero messages, `listThreads` hid it, and the user's typed message vanished on
 * reload. A successful turn later overwrites this with the full transcript, which starts
 * with this same message (same id).
 *
 * IDEMPOTENT on `firstTurn.id`. A server action can fail AFTER its insert committed (the
 * response is lost on the way back), and the client then retries with the SAME client-minted
 * id. Inserting again would leave two threads holding one message, the first of them never
 * attached and so never answered. So a row whose stored first turn already carries this id is
 * returned instead of a new one, with its turn and title rewritten while it holds only that
 * turn (the retry may carry edited text). This is a read-then-insert, not a constraint: it
 * covers SEQUENTIAL retries, which is what the client issues — `useElenchSend` never runs two
 * first sends at once.
 *
 * The rewrite is a write to `messages`, so it bumps `revision` in the same UPDATE (ADR 0003 §4.2),
 * and the returned row carries the new revision. It takes the thread row's lock first and does
 * NOTHING while the thread has a running turn claim: only the attempt writes `messages` while it
 * runs, so a rewrite here could otherwise replace a transcript the attempt is about to finalize
 * against. The lock is what makes the claim probe sound once ADR 0003 slice 5 lands — its
 * acceptance locks the same row before it inserts its claim, so the probe (a fresh statement under
 * READ COMMITTED) sees any claim committed before the lock was granted. Until then nothing inserts
 * a claim, so the probe always finds none.
 */
export async function createThread(
	title?: string,
	projectId?: string,
	firstTurn?: FirstTurn,
): Promise<AgentThread> {
	const turn = firstTurn === undefined ? null : firstTurnSchema.parse(firstTurn);
	const messages: UIMessage[] = turn
		? [{ id: turn.id, role: "user", parts: [{ type: "text", text: turn.text }] }]
		: [];
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		if (turn) {
			const [existing] = await tx
				.select()
				.from(agentThreads)
				.where(
					and(
						eq(agentThreads.kind, "agent"),
						live,
						sql`${agentThreads.messages}->0->>'id' = ${turn.id}`,
					),
				)
				.limit(1)
				.for("update");
			if (existing) {
				const [running] = await tx
					.select({ id: agentTurnClaims.id })
					.from(agentTurnClaims)
					.where(
						and(
							eq(agentTurnClaims.thread_id, existing.id),
							eq(agentTurnClaims.state, "running"),
						),
					)
					.limit(1);
				if (running) return existing;
				const [rewritten] = await tx
					.update(agentThreads)
					.set({
						title: threadTitle(title),
						messages,
						revision: sql`${agentThreads.revision} + 1`,
						updated_at: sql`now()`,
					})
					.where(
						and(
							eq(agentThreads.id, existing.id),
							sql`jsonb_array_length(${agentThreads.messages}) = 1`,
						),
					)
					.returning();
				return rewritten ?? existing;
			}
		}
		const [thread] = await tx
			.insert(agentThreads)
			.values({
				user_id: owner,
				org_id: owner,
				title: threadTitle(title),
				...(turn ? { messages } : {}),
				...(projectId ? { project_id: projectId } : {}),
			})
			.returning();
		return thread;
	});
}

/**
 * List the owner's threads, most-recently-updated first (RLS scopes the rows).
 * `projectId` set → that project's conversations; omitted → org-level threads only
 * (project_id IS NULL), so the org rail never mixes in project chats.
 *
 * A thread whose first send stored its user turn (`createThread` with `firstTurn`) is never
 * empty, so it is listed even when that turn failed. A row created WITHOUT a turn (an artifact
 * opened in a new chat, and every row written before the turn was stored) has zero messages; we
 * never surface those, and reap this owner's stale ones (older than an hour, so a row a turn is
 * about to fill is never swept) on the way through. A turn that finishes into a reaped row
 * recreates it (`saveThreadTranscript`).
 *
 * A deleted thread's tombstone (`deleteThread`) is never listed, and is reaped a day after the
 * delete — far past the longest a turn that was streaming at the delete can run, so such a turn's
 * save always finds it. That bound is ADR 0003 §8.2's, and it holds from ADR 0003 slice 6 on: a
 * turn is aborted at `TURN_BUDGET_MS` (15 minutes) after its acceptance, and a claim whose route
 * died is expired after its 90 s lease goes silent, so a turn streaming at the delete finalizes
 * within about 16 minutes. Until slice 6 lands no route takes a claim and no turn is bounded (the
 * routes' `maxDuration` of 300 s bounds nothing on a standalone Node server), so the day is a margin,
 * not a proven bound. A NEW turn sent into the deleted id
 * from a tab that still shows the thread is not bounded that way: within the day it is saved into
 * a "Recovered: …" thread, and after the reap it recreates the thread under its id.
 */
export async function listThreads(projectId?: string): Promise<AgentThread[]> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		await tx
			.delete(agentThreads)
			.where(
				or(
					and(
						eq(agentThreads.kind, "agent"),
						live,
						sql`jsonb_array_length(${agentThreads.messages}) = 0`,
						sql`${agentThreads.created_at} < now() - interval '1 hour'`,
					),
					and(
						eq(agentThreads.status, THREAD_DELETED),
						sql`${agentThreads.updated_at} < now() - interval '1 day'`,
					),
				),
			);
		return tx
			.select()
			.from(agentThreads)
			.where(
				and(
					eq(agentThreads.kind, "agent"),
					live,
					projectId
						? eq(agentThreads.project_id, projectId)
						: isNull(agentThreads.project_id),
					sql`jsonb_array_length(${agentThreads.messages}) > 0`,
				),
			)
			.orderBy(desc(agentThreads.updated_at));
	});
}

/**
 * Load one thread (with its full message transcript and its `revision`); null when there is none, or
 * it was deleted. `inFlight` names the turn a running claim is answering (ADR 0003 §4.2), read only
 * from a claim whose lease is NOT silent (`lease_until >= now()`): a dead process's claim must not
 * show "Being answered" while it waits for the sweep to expire it. RLS (`owner_only`) scopes the
 * claim read to this owner.
 */
export async function getThread(id: string): Promise<LoadedThread | null> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [thread] = await tx
			.select()
			.from(agentThreads)
			.where(and(eq(agentThreads.id, id), live))
			.limit(1);
		if (!thread) return null;
		const [claim] = await tx
			.select({
				turnId: agentTurnClaims.turn_id,
				since: agentTurnClaims.accepted_at,
			})
			.from(agentTurnClaims)
			.where(
				and(
					eq(agentTurnClaims.thread_id, thread.id),
					eq(agentTurnClaims.state, "running"),
					gte(agentTurnClaims.lease_until, sql`now()`),
				),
			)
			.limit(1);
		return { ...thread, inFlight: claim ?? null };
	});
}

/** Rename a thread. */
export async function renameThread(id: string, title: string): Promise<void> {
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		await tx
			.update(agentThreads)
			.set({ title, updated_at: sql`now()` })
			.where(and(eq(agentThreads.id, id), live));
	});
}

/** What `deleteThread` answers: how many of the caller's Elench drafts of the thread it purged. */
export interface DeleteThreadResult {
	purged: number;
}

/** The one row `purge_elench_drafts_of_conversation` answers. */
const purgedRowsSchema = z.array(z.object({ n: z.number().int().min(0) }));

/**
 * Delete a thread: its row goes (and with it, by cascade, everything hung on it — its widgets and
 * message feedback), and a TOMBSTONE takes its id — no title, no messages, `status` deleted.
 *
 * The tombstone exists for one reader: a turn that was still streaming when the user deleted the
 * thread. Its route saves the transcript when the turn finishes, and with no row at all that save
 * cannot tell a delete from the hourly reap of an empty row, which it answers by recreating the row
 * — undoing the user's delete. Finding the tombstone, it puts the transcript in a new thread instead
 * (`saveTranscript`). Every other read treats a tombstone as no thread; `listThreads` reaps it.
 *
 * In the same transaction it purges the caller's Elench drafts of this conversation in EVERY org
 * (ADR 0001 §6.3): an org-level thread is listed in every org, so a draft of it may exist in each.
 * The purge is `purge_elench_drafts_of_conversation`, the owner-pinned SECURITY DEFINER function in
 * programmables.sql: it crosses orgs, which the drafts policy cannot from one org's scope, and it
 * reads the owner from the GUC `withOwnerScope` sets, so it never reaches another user's drafts. It
 * runs whether or not a live row was deleted, so a conversation's drafts go with it even when its
 * thread was already gone. The answer counts the drafts purged.
 */
export async function deleteThread(id: string): Promise<DeleteThreadResult> {
	const threadId = z.uuid().parse(id);
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [deleted] = await tx
			.delete(agentThreads)
			.where(and(eq(agentThreads.id, threadId), live))
			.returning({
				user_id: agentThreads.user_id,
				org_id: agentThreads.org_id,
				project_id: agentThreads.project_id,
				kind: agentThreads.kind,
			});
		if (deleted) {
			await tx.insert(agentThreads).values({
				id: threadId,
				user_id: deleted.user_id,
				org_id: deleted.org_id,
				project_id: deleted.project_id,
				kind: deleted.kind,
				title: "",
				status: THREAD_DELETED,
			});
		}
		const purged = await tx.execute(
			sql`select public.purge_elench_drafts_of_conversation(${threadId}::uuid) as n`,
		);
		return { purged: purgedRowsSchema.parse(purged)[0]?.n ?? 0 };
	});
}
