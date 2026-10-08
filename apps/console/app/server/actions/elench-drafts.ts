"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench draft actions (ADR 0001 §4.2): `listDrafts`, `saveDraft`, `discardDraft` and
// `restoreDraft`. Each parses its input with zod (§4 step 1), then runs behind the preamble in
// lib/elench/draft-gate.ts, and answers an outcome of lib/elench/draft-outcomes.ts. Every write is a
// compare-and-set on `revision`, under a `FOR UPDATE` lock of the key's row.
//
// No claim exists yet: `claimDraft`, `consumeDraft`, `releaseClaim` and the lease settle (S5) are
// slice 4's, so until slice 4 lands no row is ever `sending`. From slice 4, every action here that
// locks or lists a row will first settle a claim that has been silent for 120 s.

import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";
import { type ElenchDraft, elenchDrafts } from "@/lib/db/schema";
import { contentSchema } from "@/lib/elench/draft-content";
import {
	lockDraft,
	readThread,
	readThreadSummaries,
	runDraftGate,
	threadStatusOf,
	toServerDraft,
} from "@/lib/elench/draft-gate";
import type {
	DiscardDraftResult,
	DraftClaimed,
	DraftConflict,
	DraftDiscardedRefusal,
	DraftGone,
	DraftListEntry,
	ListDraftsResult,
	RestoreDraftResult,
	SaveDraftResult,
} from "@/lib/elench/draft-outcomes";
import type { ElenchFailedSend } from "@/types/jsonb.types";

/** The most ACTIVE drafts one scope may hold; a new row past it is refused with `limit` (§4.3). */
const MAX_ACTIVE_DRAFTS_PER_SCOPE = 200;

/** A key (§2): the page org's id, the anchor, and the conversation. Never a `user_id`. */
const keySchema = z.object({
	orgId: z.uuid(),
	projectId: z.uuid().nullable(),
	conversationId: z.uuid(),
});

/** A compare-and-set base: 0 means "no row yet". */
const baseRevisionSchema = z.number().int().min(0).max(2_147_483_647);

/** The opaque per-page-load tab id (§7.1), used only to word a conflict. */
const tabIdSchema = z.string().min(1).max(64);

/**
 * The failed-send marker an external send's failure carries (D10f). `error` is a failure code
 * (a status, `reload`, a refusal name), never model output or the user's text, so it is held to a
 * code's shape rather than to a length alone.
 */
const failedSendSchema = z.object({
	turnId: z.uuid().nullable(),
	kind: z.enum(["first", "later"]),
	error: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
	uncertain: z.boolean(),
});

const listDraftsSchema = z.object({
	projectId: z.uuid().nullable(),
	orgHint: z.uuid().optional(),
});

const saveDraftSchema = keySchema.extend({
	baseRevision: baseRevisionSchema,
	content: contentSchema,
	threadSeen: z.boolean().optional(),
	tabId: tabIdSchema,
	failedSend: failedSendSchema.optional(),
	dismissFailedSend: z.boolean().optional(),
});

const casSchema = keySchema.extend({ baseRevision: baseRevisionSchema });

/** `listDrafts`' input: the anchor, and the org id of the scope this tab last listed (A12). */
export type ListDraftsInput = z.input<typeof listDraftsSchema>;
/** `saveDraft`'s input (§4.2). */
export type SaveDraftInput = z.input<typeof saveDraftSchema>;
/** `discardDraft`'s and `restoreDraft`'s input: a key and a base revision. */
export type DraftCasInput = z.input<typeof casSchema>;

/** True when a row's anchor is the request's: the anchor is immutable after insert (§3.1). */
function sameAnchor(row: ElenchDraft, projectId: string | null): boolean {
	return row.project_id === projectId;
}

/**
 * The refusal for a row that is not an `active` row at the request's base: `claimed` while it is
 * frozen by a claim, `discarded` while it is discarded, `conflict` otherwise. Each carries the row
 * and its thread, read in this transaction.
 */
async function refuseRow(
	tx: Tx,
	actor: Actor,
	row: ElenchDraft,
): Promise<DraftClaimed | DraftDiscardedRefusal | DraftConflict> {
	const thread = await readThread(tx, actor, row.conversation_id, row.claim_turn_id, row.text);
	const answer = {
		row: toServerDraft(row),
		thread: { status: thread.status, firstTurnId: thread.firstTurnId, hasTurn: thread.hasTurn },
	};
	if (row.status === "sending") return { outcome: "claimed", ...answer };
	if (row.status === "discarded") return { outcome: "discarded", ...answer };
	return { outcome: "conflict", ...answer };
}

/** The `conflict(row, thread)` answer for a row, whatever its state. */
async function conflictOf(tx: Tx, actor: Actor, row: ElenchDraft): Promise<DraftConflict> {
	const refusal = await refuseRow(tx, actor, row);
	return { outcome: "conflict", row: refusal.row, thread: refusal.thread };
}

/** The `gone(thread)` answer: there is no row for the key. */
async function goneOf(tx: Tx, actor: Actor, conversationId: string): Promise<DraftGone> {
	const thread = await readThread(tx, actor, conversationId, null, "");
	return {
		outcome: "gone",
		thread: { status: thread.status, firstTurnId: thread.firstTurnId, hasTurn: thread.hasTurn },
	};
}

/**
 * Lists the caller's drafts of one scope (§4.2): the active and sending drafts, plus the drafts
 * discarded in the last 24 hours, newest first, each with its thread's status and title. The org is
 * the page's (`currentActor()`), never an input.
 */
export async function listDrafts(input: ListDraftsInput): Promise<ListDraftsResult> {
	const parsed = listDraftsSchema.safeParse(input);
	if (!parsed.success) return { outcome: "invalid" };
	const { projectId, orgHint } = parsed.data;
	return runDraftGate(
		{ keyOrgId: null, orgHint: orgHint ?? null, projectId },
		async (actor, tx): Promise<ListDraftsResult> => {
			const rows = await tx
				.select()
				.from(elenchDrafts)
				.where(
					and(
						eq(elenchDrafts.user_id, actor.userId),
						eq(elenchDrafts.org_id, actor.orgId),
						projectId === null
							? isNull(elenchDrafts.project_id)
							: eq(elenchDrafts.project_id, projectId),
						sql`(${elenchDrafts.status} in ('active', 'sending') or (${elenchDrafts.status} = 'discarded' and ${elenchDrafts.discarded_at} > now() - interval '24 hours'))`,
					),
				)
				.orderBy(desc(elenchDrafts.updated_at));
			const threads = await readThreadSummaries(
				tx,
				actor,
				rows.map((r) => r.conversation_id),
			);
			const drafts: DraftListEntry[] = [];
			for (const row of rows) {
				const summary = threads.get(row.conversation_id);
				const status = threadStatusOf(summary);
				const live = status === "listed" || status === "unlisted";
				// Only a `sending` row names a turn, so only it needs the transcript read of `hasTurn`.
				const hasTurn =
					row.status === "sending" && status === "listed"
						? (await readThread(tx, actor, row.conversation_id, row.claim_turn_id, row.text))
								.hasTurn
						: false;
				drafts.push({
					row: toServerDraft(row),
					thread: {
						status,
						firstTurnId: live ? (summary?.firstTurnId ?? null) : null,
						hasTurn,
					},
					threadTitle: live ? (summary?.title ?? null) : null,
				});
			}
			return { outcome: "ok", orgId: actor.orgId, drafts };
		},
	);
}

/**
 * The failed-send marker a save leaves on the row (§4.2): the input's marker when it carries one
 * (D10f, stamped with the server's clock); none when the caller dismisses it (D31); none when the
 * text changed and the marker is not `uncertain`; otherwise the row's own.
 */
function nextFailedSend(
	current: ElenchFailedSend | null,
	textChanged: boolean,
	input: Pick<z.output<typeof saveDraftSchema>, "failedSend" | "dismissFailedSend">,
): ElenchFailedSend | null {
	if (input.failedSend) return { ...input.failedSend, at: new Date().toISOString() };
	if (input.dismissFailedSend) return null;
	if (current && textChanged && !current.uncertain) return null;
	return current;
}

/**
 * Saves a draft's content by compare-and-set (§4.2). Inserts the key's row when `baseRevision` is 0
 * and there is none (refused with `limit` past §4.3's bound); otherwise updates it only while it is
 * `active` at `baseRevision`. With `failedSend` (D10f) the marker is written in the same
 * compare-and-set as the content. `thread_seen` is set only when the client says it saw the thread
 * AND the server finds the caller's thread row.
 */
export async function saveDraft(input: SaveDraftInput): Promise<SaveDraftResult> {
	const parsed = saveDraftSchema.safeParse(input);
	if (!parsed.success) return { outcome: "invalid" };
	const req = parsed.data;
	return runDraftGate(
		{ keyOrgId: req.orgId, orgHint: null, projectId: req.projectId },
		async (actor, tx): Promise<SaveDraftResult> => {
			const row = await lockDraft(tx, actor, req.conversationId);
			const seen =
				req.threadSeen === true && !row?.thread_seen
					? await readThread(tx, actor, req.conversationId, null, "")
					: null;
			const sawThread = seen !== null && seen.status !== "none";

			if (row === null) {
				if (req.baseRevision > 0) return goneOf(tx, actor, req.conversationId);
				const [count] = await tx
					.select({ n: sql<number>`count(*)`.mapWith(Number) })
					.from(elenchDrafts)
					.where(
						and(
							eq(elenchDrafts.user_id, actor.userId),
							eq(elenchDrafts.org_id, actor.orgId),
							req.projectId === null
								? isNull(elenchDrafts.project_id)
								: eq(elenchDrafts.project_id, req.projectId),
							eq(elenchDrafts.status, "active"),
						),
					);
				if ((count?.n ?? 0) >= MAX_ACTIVE_DRAFTS_PER_SCOPE) return { outcome: "limit" };
				const [inserted] = await tx
					.insert(elenchDrafts)
					.values({
						user_id: actor.userId,
						org_id: actor.orgId,
						project_id: req.projectId,
						conversation_id: req.conversationId,
						revision: 1,
						status: "active",
						text: req.content.text,
						mentions: req.content.mentions,
						artifacts: req.content.artifacts,
						cell_target: req.content.cellTarget,
						failed_send: nextFailedSend(null, false, req),
						thread_seen: sawThread,
						title: sawThread ? (seen?.title ?? null) : null,
						last_writer: req.tabId,
					})
					.onConflictDoNothing({
						target: [elenchDrafts.user_id, elenchDrafts.org_id, elenchDrafts.conversation_id],
					})
					.returning({ revision: elenchDrafts.revision });
				if (inserted) return { outcome: "saved", revision: inserted.revision };
				// A concurrent base-0 save inserted the key first; it is now a row at revision ≥ 1.
				const winner = await lockDraft(tx, actor, req.conversationId);
				if (winner === null) return goneOf(tx, actor, req.conversationId);
				return refuseRow(tx, actor, winner);
			}

			if (!sameAnchor(row, req.projectId)) return { outcome: "invalid" };
			if (row.status !== "active" || row.revision !== req.baseRevision) {
				return refuseRow(tx, actor, row);
			}

			const [updated] = await tx
				.update(elenchDrafts)
				.set({
					text: req.content.text,
					mentions: req.content.mentions,
					artifacts: req.content.artifacts,
					cell_target: req.content.cellTarget,
					failed_send: nextFailedSend(row.failed_send, row.text !== req.content.text, req),
					thread_seen: row.thread_seen || sawThread,
					...(sawThread ? { title: seen?.title ?? null } : {}),
					last_writer: req.tabId,
					revision: row.revision + 1,
					updated_at: sql`now()`,
				})
				.where(casPredicate(actor, row, req.baseRevision, "active"))
				.returning({ revision: elenchDrafts.revision });
			if (!updated) return conflictOf(tx, actor, row);
			return { outcome: "saved", revision: updated.revision };
		},
	);
}

/**
 * The compare-and-set predicate of every write: this row, still the actor's, still at `base`, and
 * still in `status`. The row is locked, so this always holds when the checks before it passed; it
 * is what makes the write a compare-and-set rather than a blind one if a path ever reaches here
 * without the lock.
 */
function casPredicate(
	actor: Actor,
	row: ElenchDraft,
	base: number,
	status: ElenchDraft["status"],
): SQL | undefined {
	return and(
		eq(elenchDrafts.id, row.id),
		eq(elenchDrafts.user_id, actor.userId),
		eq(elenchDrafts.org_id, actor.orgId),
		eq(elenchDrafts.revision, base),
		eq(elenchDrafts.status, status),
	);
}

/**
 * Discards a draft softly (§6.2): marks the row `discarded` when it is `active` at `baseRevision`,
 * and keeps its content for 24 hours. It never touches `agent_threads`.
 */
export async function discardDraft(input: DraftCasInput): Promise<DiscardDraftResult> {
	const parsed = casSchema.safeParse(input);
	if (!parsed.success) return { outcome: "invalid" };
	const req = parsed.data;
	return runDraftGate(
		{ keyOrgId: req.orgId, orgHint: null, projectId: req.projectId },
		async (actor, tx): Promise<DiscardDraftResult> => {
			const row = await lockDraft(tx, actor, req.conversationId);
			if (row === null) return goneOf(tx, actor, req.conversationId);
			if (!sameAnchor(row, req.projectId)) return { outcome: "invalid" };
			if (row.status === "sending") {
				const refusal = await refuseRow(tx, actor, row);
				return { outcome: "claimed", row: refusal.row, thread: refusal.thread };
			}
			if (row.status !== "active" || row.revision !== req.baseRevision) {
				return conflictOf(tx, actor, row);
			}
			const [updated] = await tx
				.update(elenchDrafts)
				.set({
					status: "discarded",
					discarded_at: sql`now()`,
					revision: row.revision + 1,
					updated_at: sql`now()`,
				})
				.where(casPredicate(actor, row, req.baseRevision, "active"))
				.returning({ revision: elenchDrafts.revision });
			if (!updated) return conflictOf(tx, actor, row);
			return { outcome: "discarded", revision: updated.revision };
		},
	);
}

/** Restores a discarded draft (§6.2, Undo): back to `active` when it is discarded at `baseRevision`. */
export async function restoreDraft(input: DraftCasInput): Promise<RestoreDraftResult> {
	const parsed = casSchema.safeParse(input);
	if (!parsed.success) return { outcome: "invalid" };
	const req = parsed.data;
	return runDraftGate(
		{ keyOrgId: req.orgId, orgHint: null, projectId: req.projectId },
		async (actor, tx): Promise<RestoreDraftResult> => {
			const row = await lockDraft(tx, actor, req.conversationId);
			if (row === null) return goneOf(tx, actor, req.conversationId);
			if (!sameAnchor(row, req.projectId)) return { outcome: "invalid" };
			if (row.status !== "discarded" || row.revision !== req.baseRevision) {
				return conflictOf(tx, actor, row);
			}
			const [updated] = await tx
				.update(elenchDrafts)
				.set({
					status: "active",
					discarded_at: null,
					revision: row.revision + 1,
					updated_at: sql`now()`,
				})
				.where(casPredicate(actor, row, req.baseRevision, "discarded"))
				.returning({ revision: elenchDrafts.revision });
			if (!updated) return conflictOf(tx, actor, row);
			return { outcome: "saved", revision: updated.revision };
		},
	);
}
