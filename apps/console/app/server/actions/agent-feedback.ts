"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { agentMessageFeedback } from "@/lib/db/schema";

/**
 * Record (or clear) the owner's thumbs feedback on one assistant message.
 * `value` "up"/"down" upserts on (thread, message, owner); `null` clears it (toggle off).
 */
export async function setMessageFeedback(
	threadId: string,
	messageId: string,
	value: "up" | "down" | null,
): Promise<void> {
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		if (value === null) {
			await tx
				.delete(agentMessageFeedback)
				.where(
					and(
						eq(agentMessageFeedback.thread_id, threadId),
						eq(agentMessageFeedback.message_id, messageId),
						eq(agentMessageFeedback.user_id, owner),
					),
				);
			return;
		}
		await tx
			.insert(agentMessageFeedback)
			.values({
				thread_id: threadId,
				user_id: owner,
				org_id: owner,
				message_id: messageId,
				value,
			})
			.onConflictDoUpdate({
				target: [
					agentMessageFeedback.thread_id,
					agentMessageFeedback.message_id,
					agentMessageFeedback.user_id,
				],
				set: { value, updated_at: new Date() },
			});
	});
}

/**
 * The owner's prior thumbs for a thread as a `{ [messageId]: "up" | "down" }` map — seeds the
 * transcript's feedback state on load so a rating stays filled across a reload.
 */
export async function getThreadFeedback(
	threadId: string,
): Promise<Record<string, "up" | "down">> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const rows = await tx
			.select({
				message_id: agentMessageFeedback.message_id,
				value: agentMessageFeedback.value,
			})
			.from(agentMessageFeedback)
			.where(eq(agentMessageFeedback.thread_id, threadId));
		const map: Record<string, "up" | "down"> = {};
		for (const r of rows) map[r.message_id] = r.value;
		return map;
	});
}
