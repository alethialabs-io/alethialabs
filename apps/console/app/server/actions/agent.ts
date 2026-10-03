"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/owner";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";
import { withOwnerScope } from "@/lib/db";
import { type AgentThread, agentThreads } from "@/lib/db/schema";

/** Derive a thread title from the first user message (or a default). */
function titleFrom(firstMessage?: string): string {
	const t = (firstMessage ?? "").trim().replace(/\s+/g, " ");
	if (!t) return "New chat";
	return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

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
		const [thread] = await tx
			.insert(agentThreads)
			.values({
				user_id: owner,
				org_id: owner,
				title: titleFrom(title),
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
 * empty, so it is listed even when that turn failed. A row created WITHOUT a turn (today:
 * an artifact opened in a new chat, and every row written before the turn was stored) has
 * zero messages; we never surface those, and reap this owner's stale ones (older than an
 * hour, so a row a turn is about to fill is never swept) on the way through.
 */
export async function listThreads(projectId?: string): Promise<AgentThread[]> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		await tx
			.delete(agentThreads)
			.where(
				and(
					eq(agentThreads.kind, "agent"),
					sql`jsonb_array_length(${agentThreads.messages}) = 0`,
					sql`${agentThreads.created_at} < now() - interval '1 hour'`,
				),
			);
		return tx
			.select()
			.from(agentThreads)
			.where(
				and(
					eq(agentThreads.kind, "agent"),
					projectId
						? eq(agentThreads.project_id, projectId)
						: isNull(agentThreads.project_id),
					sql`jsonb_array_length(${agentThreads.messages}) > 0`,
				),
			)
			.orderBy(desc(agentThreads.updated_at));
	});
}

/** Load one thread (with its full message transcript). */
export async function getThread(id: string): Promise<AgentThread | null> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [thread] = await tx
			.select()
			.from(agentThreads)
			.where(eq(agentThreads.id, id))
			.limit(1);
		return thread ?? null;
	});
}

/** Rename a thread. */
export async function renameThread(id: string, title: string): Promise<void> {
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		await tx
			.update(agentThreads)
			.set({ title, updated_at: sql`now()` })
			.where(eq(agentThreads.id, id));
	});
}

/** Delete a thread. */
export async function deleteThread(id: string): Promise<void> {
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		await tx.delete(agentThreads).where(eq(agentThreads.id, id));
	});
}

/** Persist the full transcript for a thread (called from the streaming route's onFinish). */
export async function saveThreadMessages(
	id: string,
	messages: UIMessage[],
): Promise<void> {
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		await tx
			.update(agentThreads)
			.set({ messages, updated_at: sql`now()` })
			.where(eq(agentThreads.id, id));
	});
}
