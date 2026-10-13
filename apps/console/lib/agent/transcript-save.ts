// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { z } from "zod";

/**
 * The `status` of a thread the user deleted. `deleteThread` replaces the row with a TOMBSTONE under
 * the same id: no title, no messages, this status. It is what lets the claim's acceptance
 * (`lockThread` in `turn-claims.ts`) refuse a turn into a thread the user deleted, where it recreates
 * a reaped one under its id; every read of a thread treats it as absent.
 */
export const THREAD_DELETED = "deleted";

/** The title a thread is given from its first user message: whitespace collapsed, 60 chars at most. */
export function threadTitle(firstMessage?: string): string {
	const t = (firstMessage ?? "").replace(/\s+/g, " ").trim() || "New chat";
	return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/**
 * A thread and where it lives: its owner, its id (a uuid, which every thread id is), its kind and
 * its project (null: in no project, an org thread). `finalizeTurn` (`turn-claims.ts`) builds one
 * from the in-memory `AcceptedTurn` (its `threadKind` and `projectId` are the route's
 * `ReserveTurnInput`, copied at acceptance) to recover a deleted thread's answer through
 * {@link recoverTranscript}.
 */
export const transcriptTargetSchema = z.object({
	owner: z.string().min(1),
	threadId: z.uuid(),
	kind: z.enum(["agent", "support"]),
	projectId: z.uuid().nullable(),
});

/** See {@link transcriptTargetSchema}. */
export type TranscriptTarget = z.infer<typeof transcriptTargetSchema>;

/**
 * The row writes of one owner's threads, over the service-role transaction of ADR 0003's claim
 * (`turn-claims.ts`). Every statement names the owner explicitly, so the service-role caller is held
 * to the same rows RLS would allow.
 */
export interface TranscriptRows {
	/**
	 * Write `messages` over the live (not deleted) row `id` of `kind` in project `projectId` (null: in
	 * no project, an org thread); true when a row matched. The project is matched so a write for one
	 * context cannot land in a thread of another — an org thread's over a project thread, or the
	 * reverse.
	 * It writes `messages`, so it adds one to `revision` (ADR 0003 §4.2). Its one caller is
	 * {@link recoverTranscript}, which writes a server-built transcript into the thread an earlier
	 * recovery made.
	 */
	updateLive(
		id: string,
		kind: TranscriptTarget["kind"],
		projectId: string | null,
		messages: UIMessage[],
	): Promise<boolean>;
	/**
	 * Append `messages` to the STORED transcript of the live row `id` (ADR 0003 §7), only while its
	 * revision is `baseRevision`, and add one to the revision in the same statement. The append is
	 * done by the database (`messages || $new`), so the stored list is never replaced by one the
	 * caller holds. Returns the new revision, or null when no row matched (not live, another kind
	 * or project, or the revision moved).
	 */
	appendLive(
		id: string,
		kind: TranscriptTarget["kind"],
		projectId: string | null,
		baseRevision: number,
		messages: UIMessage[],
	): Promise<number | null>;
	/**
	 * Replace the LAST stored message of the live row `id` with `message`, only while its revision is
	 * `baseRevision`, and add one to the revision (ADR 0003 §7): a regenerate replaces its answer, a
	 * continuation replaces the answer it continued, and a resume replaces the continued answer whose
	 * tail it re-ran. Every earlier message stays as stored. Returns the new revision, or null when no
	 * row matched (as {@link appendLive}) or the transcript is empty.
	 */
	replaceLast(
		id: string,
		kind: TranscriptTarget["kind"],
		projectId: string | null,
		baseRevision: number,
		message: UIMessage,
	): Promise<number | null>;
	/**
	 * The live row of `kind` in project `projectId`, other than `deletedId`, whose transcript starts
	 * with message `firstMessageId` — the thread an earlier {@link recoverTranscript} put this
	 * conversation into — or null.
	 */
	findRecovered(
		deletedId: string,
		kind: TranscriptTarget["kind"],
		projectId: string | null,
		firstMessageId: string,
	): Promise<string | null>;
	/**
	 * Insert a thread; with `id` under that id, else under a new one. Returns its id, or null when
	 * `id` is already held by a row this owner cannot see (nothing is overwritten).
	 */
	insert(row: {
		id?: string;
		title: string;
		kind: TranscriptTarget["kind"];
		projectId: string | null;
		messages: UIMessage[];
	}): Promise<string | null>;
}

/** The text of the first user message in a transcript, for a recovered thread's title. */
function firstUserText(messages: UIMessage[]): string | undefined {
	const first = messages.find((m) => m.role === "user");
	if (!first) return undefined;
	return first.parts
		.map((p) => (p.type === "text" ? p.text : ""))
		.join(" ")
		.trim();
}

/**
 * Put the transcript of a thread the user DELETED into another thread, never back into the deleted
 * one: ADR 0003 §5.3's `deleted` outcome, whose finalize calls it on its own transaction when the
 * thread's row is a tombstone or gone. A later turn of the same conversation finds the thread
 * an earlier recovery made by its first message and writes into it; otherwise a NEW thread titled
 * "Recovered: …" is inserted, which the rail lists. Throws when no thread could be written.
 */
export async function recoverTranscript(
	rows: TranscriptRows,
	target: TranscriptTarget,
	messages: UIMessage[],
): Promise<{ kind: "recovered"; threadId: string }> {
	const { threadId, kind, projectId } = target;
	const first = messages[0]?.id;
	const earlier = first ? await rows.findRecovered(threadId, kind, projectId, first) : null;
	if (earlier && (await rows.updateLive(earlier, kind, projectId, messages))) {
		return { kind: "recovered", threadId: earlier };
	}
	const recovered = await rows.insert({
		title: threadTitle(`Recovered: ${firstUserText(messages) ?? ""}`),
		kind,
		projectId,
		messages,
	});
	if (!recovered) throw new Error(`Thread ${threadId} was deleted and its transcript could not be recovered.`);
	return { kind: "recovered", threadId: recovered };
}
