"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { desc, eq, sql } from "drizzle-orm";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { type AgentThread, agentThreads } from "@/lib/db/schema";

/** Derive a thread title from the first user message (or a default). */
function titleFrom(firstMessage?: string): string {
	const t = (firstMessage ?? "").trim().replace(/\s+/g, " ");
	if (!t) return "New chat";
	return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/** Create a new owner-scoped agent chat thread. */
export async function createThread(firstMessage?: string): Promise<AgentThread> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [thread] = await tx
			.insert(agentThreads)
			.values({ user_id: owner, org_id: owner, title: titleFrom(firstMessage) })
			.returning();
		return thread;
	});
}

/** List the owner's threads, most-recently-updated first. RLS scopes the rows. */
export async function listThreads(): Promise<AgentThread[]> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) =>
		tx.select().from(agentThreads).orderBy(desc(agentThreads.updated_at)),
	);
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
