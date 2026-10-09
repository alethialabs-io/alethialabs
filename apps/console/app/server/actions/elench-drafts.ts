"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench draft actions (ADR 0001 §4.2): `listDrafts`, `saveDraft`, `discardDraft`,
// `restoreDraft`, and the claim (§3.4): `claimDraft`, `consumeDraft` and `releaseClaim`. Each parses
// its input with zod (§4 step 1), then runs behind the preamble in lib/elench/draft-gate.ts, and
// answers an outcome of lib/elench/draft-outcomes.ts. Every write is a compare-and-set on
// `revision`, or on the claim token, under a `FOR UPDATE` lock of the key's row.
//
// The lease settle (S5, lib/elench/draft-claims.ts) runs first inside every action here that locks
// or lists a row, EXCEPT for a claim whose token the request itself presents: `consumeDraft` and
// `releaseClaim` act on their own claim whatever its age, and a `claimDraft` retried with its own
// token (S1r) answers that claim again. The claim's heartbeat (S7) is not an action: it is the route
// handler app/api/elench/drafts/heartbeat/route.ts, so Next's action queue cannot starve it (B1).

import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";
import { type ElenchDraft, elenchDrafts } from "@/lib/db/schema";
import {
	claimOf,
	endClaim,
	goneOf,
	notClaimedOf,
	type RowClaim,
	settleIfSilent,
	settleScope,
} from "@/lib/elench/draft-claims";
import { contentSchema } from "@/lib/elench/draft-content";
import {
	lockDraft,
	lockDraftScope,
	readThread,
	readThreadSummaries,
	runDraftGate,
	storedTurn,
	threadStatusOf,
	toServerDraft,
} from "@/lib/elench/draft-gate";
import type {
	ClaimDraftResult,
	ConsumeDraftResult,
	DiscardDraftResult,
	DraftClaimed,
	DraftConflict,
	DraftDiscardedRefusal,
	DraftGone,
	DraftInvalid,
	DraftListEntry,
	DraftNotClaimed,
	ListDraftsResult,
	ReleaseClaimResult,
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

/** The state a claim moves a row to (§3.4). */
const SENDING: ElenchDraft["status"] = "sending";

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

/**
 * A claim token: a random UUID that, from slices 7b and 8, the claiming tab will mint per attempt
 * and send with every request of that claim.
 */
const tokenSchema = z.uuid();

const claimDraftSchema = keySchema.extend({
	baseRevision: baseRevisionSchema,
	content: contentSchema,
	turnId: z.uuid(),
	token: tokenSchema,
	kind: z.enum(["first", "later"]),
	tabId: tabIdSchema,
});

const consumeDraftSchema = keySchema.extend({ token: tokenSchema });

const releaseClaimSchema = keySchema.extend({
	token: tokenSchema,
	error: failedSendSchema.shape.error,
	uncertain: z.boolean().optional(),
	freshTurnId: z.uuid().optional(),
});

/** `listDrafts`' input: the anchor, and the org id of the scope this tab last listed (A12). */
export type ListDraftsInput = z.input<typeof listDraftsSchema>;
/** `saveDraft`'s input (§4.2). */
export type SaveDraftInput = z.input<typeof saveDraftSchema>;
/** `discardDraft`'s and `restoreDraft`'s input: a key and a base revision. */
export type DraftCasInput = z.input<typeof casSchema>;
/** `claimDraft`'s input (§4.2): the box's content at its base revision, and the attempt's claim. */
export type ClaimDraftInput = z.input<typeof claimDraftSchema>;
/** `consumeDraft`'s input: a key and the claim's token. */
export type ConsumeDraftInput = z.input<typeof consumeDraftSchema>;
/** `releaseClaim`'s input (§4.2): a key, the claim's token, and why the send failed. */
export type ReleaseClaimInput = z.input<typeof releaseClaimSchema>;

/**
 * Locks the caller's row for a key and settles its claim first when that claim has been silent past
 * the lease (S5). For an action that presents no claim token, so it may settle any claim.
 */
async function lockAndSettle(
	tx: Tx,
	actor: Actor,
	conversationId: string,
): Promise<ElenchDraft | null> {
	const row = await lockDraft(tx, actor, conversationId);
	return row === null ? null : settleIfSilent(tx, actor, row, null);
}

/**
 * §4.3: whether the scope already holds the bound of active drafts, so a NEW row must be refused.
 * A count, then an insert: serialized per scope by an advisory lock, so a concurrent base-0 write
 * of another conversation cannot read the same count and land the 201st row.
 */
async function scopeIsFull(tx: Tx, actor: Actor, projectId: string | null): Promise<boolean> {
	await lockDraftScope(tx, actor, projectId);
	const [count] = await tx
		.select({ n: sql<number>`count(*)`.mapWith(Number) })
		.from(elenchDrafts)
		.where(
			and(
				eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), authorized upstream by runDraftGate; explicit predicate on top of owner_only RLS
				eq(elenchDrafts.org_id, actor.orgId),
				projectId === null ? isNull(elenchDrafts.project_id) : eq(elenchDrafts.project_id, projectId),
				eq(elenchDrafts.status, "active"),
			),
		);
	return (count?.n ?? 0) >= MAX_ACTIVE_DRAFTS_PER_SCOPE;
}

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
			await settleScope(tx, actor, projectId);
			const rows = await tx
				.select()
				.from(elenchDrafts)
				.where(
					and(
						eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), authorized upstream by runDraftGate; explicit predicate on top of owner_only RLS
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
			const row = await lockAndSettle(tx, actor, req.conversationId);
			const seen =
				req.threadSeen === true && !row?.thread_seen
					? await readThread(tx, actor, req.conversationId, null, "")
					: null;
			const sawThread = seen !== null && seen.status !== "none";

			if (row === null) {
				if (req.baseRevision > 0) return goneOf(tx, actor, req.conversationId);
				if (await scopeIsFull(tx, actor, req.projectId)) return { outcome: "limit" };
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
		eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), authorized upstream by runDraftGate; explicit predicate on top of owner_only RLS
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
			const row = await lockAndSettle(tx, actor, req.conversationId);
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
			const row = await lockAndSettle(tx, actor, req.conversationId);
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

/**
 * Claims a draft for one send (S1, §3.4): saves the box's content and moves the row to `sending`
 * in one compare-and-set at `baseRevision` (0 = no row yet), with the attempt's token, turn id and
 * kind, and clears the failed-send marker. A retry with the same token answers the claim again and
 * writes nothing (S1r). A silent claim of another token is settled first (S5).
 */
export async function claimDraft(input: ClaimDraftInput): Promise<ClaimDraftResult> {
	const parsed = claimDraftSchema.safeParse(input);
	if (!parsed.success) return { outcome: "invalid" };
	const req = parsed.data;
	return runDraftGate(
		{ keyOrgId: req.orgId, orgHint: null, projectId: req.projectId },
		async (actor, tx): Promise<ClaimDraftResult> => {
			const locked = await lockDraft(tx, actor, req.conversationId);
			if (locked !== null && !sameAnchor(locked, req.projectId)) return { outcome: "invalid" };
			if (locked !== null && claimOf(locked)?.token === req.token) return claimedByYou(locked);
			const row = locked === null ? null : await settleIfSilent(tx, actor, locked, req.token);
			if (req.content.text.trim() === "") return { outcome: "empty" };

			if (row === null && req.baseRevision > 0) return goneOf(tx, actor, req.conversationId);
			if (row !== null && (row.status !== "active" || row.revision !== req.baseRevision)) {
				return refuseRow(tx, actor, row);
			}
			const seen = await readThread(tx, actor, req.conversationId, null, "");
			const live = seen.status === "listed" || seen.status === "unlisted";
			if (live !== (req.kind === "later")) {
				return {
					outcome: "wrong-kind",
					thread: { status: seen.status, firstTurnId: seen.firstTurnId, hasTurn: seen.hasTurn },
				};
			}
			const claim = {
				text: req.content.text,
				mentions: req.content.mentions,
				artifacts: req.content.artifacts,
				cell_target: req.content.cellTarget,
				status: SENDING,
				claim_token: req.token,
				claim_turn_id: req.turnId,
				claim_kind: req.kind,
				claimed_at: sql`now()`,
				failed_send: null,
				last_writer: req.tabId,
				updated_at: sql`now()`,
			};

			if (row === null) {
				if (await scopeIsFull(tx, actor, req.projectId)) return { outcome: "limit" };
				const [inserted] = await tx
					.insert(elenchDrafts)
					.values({
						...claim,
						user_id: actor.userId,
						org_id: actor.orgId,
						project_id: req.projectId,
						conversation_id: req.conversationId,
						revision: 1,
					})
					.onConflictDoNothing({
						target: [elenchDrafts.user_id, elenchDrafts.org_id, elenchDrafts.conversation_id],
					})
					.returning({ revision: elenchDrafts.revision });
				if (inserted) {
					return { outcome: "claimed-by-you", revision: inserted.revision, content: req.content };
				}
				// A concurrent write inserted the key first: answer what it holds.
				const winner = await lockDraft(tx, actor, req.conversationId);
				if (winner === null) return goneOf(tx, actor, req.conversationId);
				if (claimOf(winner)?.token === req.token) return claimedByYou(winner);
				return refuseRow(tx, actor, winner);
			}

			const [updated] = await tx
				.update(elenchDrafts)
				.set({ ...claim, revision: row.revision + 1 })
				.where(casPredicate(actor, row, req.baseRevision, "active"))
				.returning({ revision: elenchDrafts.revision });
			if (!updated) return conflictOf(tx, actor, row);
			return { outcome: "claimed-by-you", revision: updated.revision, content: req.content };
		},
	);
}

/** `claimed-by-you` for a row this request's token already holds (S1r): its revision and content. */
function claimedByYou(row: ElenchDraft): ClaimDraftResult {
	return {
		outcome: "claimed-by-you",
		revision: row.revision,
		content: {
			text: row.text,
			mentions: row.mentions,
			artifacts: row.artifacts,
			cellTarget: row.cell_target,
		},
	};
}

/**
 * The start of `consumeDraft` and `releaseClaim`: the locked row and its claim when the request's
 * token is still that claim, or the answer when it is not (`gone`, or `not-claimed` with the row as
 * it now stands). A row held by ANOTHER token may be settled by the lease first (S5); a row held by
 * this token never is, whatever its age (R0).
 */
async function lockOwnClaim(
	tx: Tx,
	actor: Actor,
	req: { projectId: string | null; conversationId: string; token: string },
): Promise<{ row: ElenchDraft; claim: RowClaim } | { answer: DraftGone | DraftInvalid | DraftNotClaimed }> {
	const row = await lockDraft(tx, actor, req.conversationId);
	if (row === null) return { answer: await goneOf(tx, actor, req.conversationId) };
	if (!sameAnchor(row, req.projectId)) return { answer: { outcome: "invalid" } };
	const claim = claimOf(row);
	if (claim === null || claim.token !== req.token) {
		const settled = await settleIfSilent(tx, actor, row, req.token);
		return { answer: await notClaimedOf(tx, actor, settled) };
	}
	return { row, claim };
}

/**
 * Consumes a later turn's claim at the hand-off (S3): the chat route accepted the turn, so the
 * draft's content is emptied, the claim cleared and `last_sent` recorded. Only this claim's token
 * may consume it. A first turn's claim is not consumed here: it becomes a turn only inside the
 * transaction that stores it (S2), so consuming it here would drop words no thread holds; that
 * request is `invalid`.
 */
export async function consumeDraft(input: ConsumeDraftInput): Promise<ConsumeDraftResult> {
	const parsed = consumeDraftSchema.safeParse(input);
	if (!parsed.success) return { outcome: "invalid" };
	const req = parsed.data;
	return runDraftGate(
		{ keyOrgId: req.orgId, orgHint: null, projectId: req.projectId },
		async (actor, tx): Promise<ConsumeDraftResult> => {
			const own = await lockOwnClaim(tx, actor, req);
			if ("answer" in own) return own.answer;
			if (own.claim.kind !== "later") return { outcome: "invalid" };
			const updated = await endClaim(tx, actor, own.row, own.claim, { end: "consume" });
			if (updated === null) return notClaimedOf(tx, actor, own.row);
			return { outcome: "consumed", revision: updated.revision };
		},
	);
}

/**
 * Releases a claim with its text intact (S4): the row goes back to `active` with the failed-send
 * marker. With `freshTurnId` (the route refused the turn as `turn-committed-different-text`) it is
 * always a release under that fresh id, never a consume, and never `uncertain`. Without it, a later
 * turn that the thread already stores with this text is consumed instead (S3, answered `consumed`),
 * and one whose id the thread stores with ANOTHER text is released with no turn id, so the next
 * claim mints a fresh one. `uncertain` is otherwise the caller's.
 */
export async function releaseClaim(input: ReleaseClaimInput): Promise<ReleaseClaimResult> {
	const parsed = releaseClaimSchema.safeParse(input);
	if (!parsed.success) return { outcome: "invalid" };
	const req = parsed.data;
	return runDraftGate(
		{ keyOrgId: req.orgId, orgHint: null, projectId: req.projectId },
		async (actor, tx): Promise<ReleaseClaimResult> => {
			const own = await lockOwnClaim(tx, actor, req);
			if ("answer" in own) return own.answer;
			const { row, claim } = own;
			let turnId: string | null = req.freshTurnId ?? claim.turnId;
			let uncertain = req.freshTurnId === undefined && req.uncertain === true;
			if (req.freshTurnId === undefined && claim.kind === "later") {
				const stored = await storedTurn(tx, actor, row.conversation_id, claim.turnId, row.text);
				if (stored === "same") {
					const consumed = await endClaim(tx, actor, row, claim, { end: "consume" });
					if (consumed === null) return notClaimedOf(tx, actor, row);
					return { outcome: "consumed", revision: consumed.revision };
				}
				if (stored === "different") {
					turnId = null;
					uncertain = false;
				}
			}
			const released = await endClaim(tx, actor, row, claim, {
				end: "release",
				turnId,
				error: req.error,
				uncertain,
			});
			if (released === null) return notClaimedOf(tx, actor, row);
			return { outcome: "released", row: toServerDraft(released) };
		},
	);
}
