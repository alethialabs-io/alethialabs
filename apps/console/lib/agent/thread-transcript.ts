// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import type { UIMessage } from "ai";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { type Tx, withOwnerScope } from "@/lib/db";
import { agentThreads } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import {
	saveTranscript,
	THREAD_DELETED,
	type TranscriptRows,
	type TranscriptSaveOutcome,
	type TranscriptTarget,
	transcriptTargetSchema,
} from "./transcript-save";

/** The predicate "this row is in `projectId`" — or in no project, for an org thread. */
function inProject(projectId: string | null) {
	return projectId ? eq(agentThreads.project_id, projectId) : isNull(agentThreads.project_id);
}

/** {@link TranscriptRows} over an owner-scoped transaction (RLS is the tenancy wall). */
function threadRows(tx: Tx, owner: string): TranscriptRows {
	return {
		async updateLive(id, kind, projectId, messages) {
			const updated = await tx
				.update(agentThreads)
				.set({ messages, updated_at: sql`now()` })
				.where(
					and(
						eq(agentThreads.id, id),
						eq(agentThreads.kind, kind),
						inProject(projectId),
						ne(agentThreads.status, THREAD_DELETED),
					),
				)
				.returning({ id: agentThreads.id });
			return updated.length > 0;
		},
		async find(id) {
			const [row] = await tx
				.select({ status: agentThreads.status })
				.from(agentThreads)
				.where(eq(agentThreads.id, id))
				.limit(1);
			return row ?? null;
		},
		async findRecovered(deletedId, kind, projectId, firstMessageId) {
			const [row] = await tx
				.select({ id: agentThreads.id })
				.from(agentThreads)
				.where(
					and(
						ne(agentThreads.id, deletedId),
						eq(agentThreads.kind, kind),
						inProject(projectId),
						ne(agentThreads.status, THREAD_DELETED),
						sql`${agentThreads.messages}->0->>'id' = ${firstMessageId}`,
					),
				)
				.limit(1);
			return row?.id ?? null;
		},
		async insert(row) {
			const [inserted] = await tx
				.insert(agentThreads)
				.values({
					...(row.id ? { id: row.id } : {}),
					user_id: owner,
					org_id: owner,
					title: row.title,
					kind: row.kind,
					messages: row.messages,
					...(row.projectId ? { project_id: row.projectId } : {}),
				})
				.onConflictDoNothing({ target: agentThreads.id })
				.returning({ id: agentThreads.id });
			return inserted?.id ?? null;
		},
	};
}

/**
 * Persist a chat route's finished turn (`onFinish`) — see `saveTranscript` for what happens when
 * the thread's row is gone or was deleted.
 *
 * NOT a server action, on purpose: this module has no "use server" directive, so it is not
 * reachable from a browser. It used to be one (`saveThreadMessages` in `app/server/actions/agent.ts`),
 * and once it could INSERT, any client could create rows with an id, kind, project and transcript
 * of its choosing (#5423 review). Only the chat routes call it, with the owner they authenticated
 * and the kind and project of their own context; `target` is validated before anything is written.
 */
export async function saveThreadTranscript(
	target: TranscriptTarget,
	messages: UIMessage[],
): Promise<TranscriptSaveOutcome> {
	const t = transcriptTargetSchema.parse(target);
	const outcome = await withOwnerScope(t.owner, (tx) =>
		saveTranscript(threadRows(tx, t.owner), t, messages),
	);
	if (outcome.kind === "recovered") {
		log.warn("chat transcript saved into a new thread: the user deleted its thread mid-turn", {
			thread_id: t.threadId,
			recovered_thread_id: outcome.threadId,
		});
	}
	return outcome;
}
