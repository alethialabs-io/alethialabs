// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { agentThreads } from "@/lib/db/schema";
import { THREAD_DELETED, type TranscriptRows } from "./transcript-save";

/** The predicate "this row is in `projectId`" — or in no project, for an org thread. */
function inProject(projectId: string | null) {
	return projectId ? eq(agentThreads.project_id, projectId) : isNull(agentThreads.project_id);
}

/**
 * {@link TranscriptRows} of `owner`'s threads over `tx`. Every statement names `user_id = owner`
 * explicitly: its caller is the service-role transaction of ADR 0003's claim (`turn-claims.ts`),
 * which bypasses RLS, so the predicate is the only thing holding it to the owner's rows (§4.3).
 */
export function transcriptRows(tx: Tx, owner: string): TranscriptRows {
	/** The live (not deleted) row `id` of `owner`, of `kind`, in `projectId`. */
	const liveRow = (id: string, kind: string, projectId: string | null) =>
		and(
			eq(agentThreads.id, id),
			eq(agentThreads.user_id, owner),
			eq(agentThreads.kind, kind),
			inProject(projectId),
			ne(agentThreads.status, THREAD_DELETED),
		);
	return {
		async updateLive(id, kind, projectId, messages) {
			const updated = await tx
				.update(agentThreads)
				.set({
					messages,
					revision: sql`${agentThreads.revision} + 1`,
					updated_at: sql`now()`,
				})
				.where(liveRow(id, kind, projectId))
				.returning({ id: agentThreads.id });
			return updated.length > 0;
		},
		async appendLive(id, kind, projectId, baseRevision, messages) {
			const [row] = await tx
				.update(agentThreads)
				.set({
					// The database appends to what it stores: no list the caller holds is written.
					messages: sql`${agentThreads.messages} || ${JSON.stringify(messages)}::jsonb`,
					revision: sql`${agentThreads.revision} + 1`,
					updated_at: sql`now()`,
				})
				.where(and(liveRow(id, kind, projectId), eq(agentThreads.revision, baseRevision)))
				.returning({ revision: agentThreads.revision });
			return row?.revision ?? null;
		},
		async replaceLast(id, kind, projectId, baseRevision, message) {
			const [row] = await tx
				.update(agentThreads)
				.set({
					// `jsonb - -1` drops the last element; every earlier message stays as stored.
					messages: sql`(${agentThreads.messages} - (-1)) || jsonb_build_array(${JSON.stringify(message)}::jsonb)`,
					revision: sql`${agentThreads.revision} + 1`,
					updated_at: sql`now()`,
				})
				.where(
					and(
						liveRow(id, kind, projectId),
						eq(agentThreads.revision, baseRevision),
						sql`jsonb_array_length(${agentThreads.messages}) > 0`,
					),
				)
				.returning({ revision: agentThreads.revision });
			return row?.revision ?? null;
		},
		async find(id) {
			const [row] = await tx
				.select({ status: agentThreads.status })
				.from(agentThreads)
				.where(and(eq(agentThreads.id, id), eq(agentThreads.user_id, owner)))
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
						eq(agentThreads.user_id, owner),
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
