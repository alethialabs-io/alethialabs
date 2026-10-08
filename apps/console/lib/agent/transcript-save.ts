// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { z } from "zod";

/**
 * The `status` of a thread the user deleted. `deleteThread` replaces the row with a TOMBSTONE under
 * the same id: no title, no messages, this status. It is what lets a late save (a turn that was
 * still streaming when the thread was deleted) tell "the user deleted this" from "this row was
 * reaped", and every read of a thread treats it as absent.
 */
export const THREAD_DELETED = "deleted";

/** The title a thread is given from its first user message: whitespace collapsed, 60 chars at most. */
export function threadTitle(firstMessage?: string): string {
	const t = (firstMessage ?? "").replace(/\s+/g, " ").trim() || "New chat";
	return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/**
 * Which thread a chat route's finished turn is saved into, and where that thread lives. Every field
 * is the ROUTE's: the owner is the authenticated caller, the kind and project are the route's own
 * context, and the thread id is the one the request named (validated here as a uuid, which every
 * thread id is).
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
 * The row writes of one owner's threads, over a transaction: the owner-scoped one the routes' save
 * runs on, or the service-role one of ADR 0003's claim (`turn-claims.ts`). Every statement names the
 * owner explicitly, so the service-role caller is held to the same rows RLS would allow.
 */
export interface TranscriptRows {
	/**
	 * Write `messages` over the live (not deleted) row `id` of `kind` in project `projectId` (null: in
	 * no project, an org thread); true when a row matched. The project is matched so one route cannot
	 * write over a thread of another context — the org route over a project thread, or the reverse.
	 * It writes `messages`, so it adds one to `revision` (ADR 0003 §4.2). Its callers are the recover
	 * branch, which writes a server-built transcript into a recovered thread, and the chat routes'
	 * wholesale save until ADR 0003 slice 6 moves them onto the claim's append.
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
	/** The row `id` in any state, or null when there is none this owner can see. */
	find(id: string): Promise<{ status: string } | null>;
	/**
	 * The live row of `kind` in project `projectId`, other than `deletedId`, whose transcript starts
	 * with message `firstMessageId` — the thread an earlier late save recovered this conversation
	 * into — or null.
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

/**
 * What a save did: wrote over the thread (`saved`); recreated it under its own id because its row
 * was gone without the user deleting it (`recreated`); or put the transcript in ANOTHER thread
 * because the user deleted this one (`recovered`, with that thread's id).
 */
export type TranscriptSaveOutcome =
	| { kind: "saved" }
	| { kind: "recreated" }
	| { kind: "recovered"; threadId: string };

/** The text of the first user message in a transcript, for a new row's title. */
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
 * one (the recover branch of {@link saveTranscript}, and ADR 0003 §5.3's `deleted` outcome, whose
 * finalize calls it on its own transaction). A later turn of the same conversation finds the thread
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

/**
 * Save a finished turn's transcript into its thread, without losing it and without undoing a delete.
 *
 * - The live row is updated: the common case.
 * - No row at all (`listThreads` reaps a zero-message row an hour after it was created): an `agent`
 *   thread is recreated under the SAME id, so the conversation the client still holds keeps saving
 *   into it and is listed again on reload. A `support` thread is never created by a save — no
 *   client creates one — so that is reported as not saved.
 * - A TOMBSTONE (the user deleted the thread while the turn was streaming, or a tab that still
 *   shows the deleted thread sent a new turn into it): the deleted row is not brought back. The
 *   transcript — the whole conversation the client holds — goes into a NEW thread titled
 *   "Recovered: …", which the rail lists, so the turn the user paid for is not lost. A later turn of
 *   the same conversation finds that thread by its first message and saves into it, rather than
 *   recovering into another one each turn. The tombstone lasts one day (`listThreads` reaps it);
 *   a turn sent into that id after the reap finds no row and recreates the thread under its id.
 *
 * Throws when the transcript could not be stored: the id is held by a row this owner cannot see, or
 * a support thread has no row. The routes log that (`transcriptNotSaved`).
 */
export async function saveTranscript(
	rows: TranscriptRows,
	target: TranscriptTarget,
	messages: UIMessage[],
): Promise<TranscriptSaveOutcome> {
	const { threadId, kind, projectId } = target;
	if (await rows.updateLive(threadId, kind, projectId, messages)) return { kind: "saved" };
	const existing = await rows.find(threadId);
	if (existing?.status === THREAD_DELETED) return recoverTranscript(rows, target, messages);
	if (existing) {
		// A live row the update did not match: a thread of another kind or project, or one written
		// between the update and this read. Never overwritten.
		throw new Error(
			`Thread ${threadId} could not be saved: its row is not a live ${kind} thread of this context that this update matched.`,
		);
	}
	if (kind !== "agent") {
		throw new Error(`Thread ${threadId} could not be saved: there is no such ${kind} thread.`);
	}
	const recreated = await rows.insert({
		id: threadId,
		title: threadTitle(firstUserText(messages)),
		kind,
		projectId,
		messages,
	});
	if (!recreated) {
		throw new Error(`Thread ${threadId} could not be saved: it is not this owner's and could not be recreated.`);
	}
	return { kind: "recreated" };
}
