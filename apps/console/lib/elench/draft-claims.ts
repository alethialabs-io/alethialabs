// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The draft claim's mechanics (ADR 0001 §3.4): the claim a `sending` row holds, the two ways a
// claim ends (S3 consume, S4 release), the 120 s lease settle (S5), and the heartbeat's renewal
// (S7). The actions in app/server/actions/elench-drafts.ts and the route handler
// app/api/elench/drafts/heartbeat/route.ts run these inside their own `withActorScope`
// transaction; nothing here resolves an actor or authorizes a scope.
//
// THE ONE RULE THE LEASE KEEPS: a request that presents the row's live `claim_token` never settles
// that claim (S5), whatever its age. `consumeDraft`, `releaseClaim` and the heartbeat act on their
// own claim; only a request that does not hold the token (every other action, or a stale token)
// may settle a claim that has been silent for {@link CLAIM_LEASE_SECONDS}. Silence is measured on
// the database's clock (`claimed_at` is written with `now()`), never the app server's.
//
// Every statement names `user_id = actor.userId` and `org_id = actor.orgId` explicitly, on top of
// the `owner_only` policy; every `agent_threads` read names `user_id = actor.userId`, because
// `owner_all` there also admits every row of the page's org (§4 step 5).

import type { UIMessage } from "ai";
import { and, eq, getTableColumns, isNull, ne, type SQL, sql } from "drizzle-orm";
import { THREAD_DELETED } from "@/lib/agent/transcript-save";
import { turnText } from "@/lib/agent/turn-key";
import type { Actor } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";
import { agentThreads, type ElenchDraft, elenchDrafts } from "@/lib/db/schema";
import { readThread, toServerDraft } from "@/lib/elench/draft-gate";
import type {
	DraftGone,
	DraftNotClaimed,
	DraftThread,
	TouchClaimResult,
} from "@/lib/elench/draft-outcomes";
import type { ElenchDraftSendKind } from "@/types/jsonb.types";

/** How long a claim may stay silent before any other request of its owner settles it (S5). */
export const CLAIM_LEASE_SECONDS = 120;

/** The failure code a lease settle writes on `failed_send.error`. */
export const LEASE_ERROR = "lease";

/** True, on the database's clock, when a row's claim has been silent past the lease. */
const claimIsSilent: SQL<boolean> = sql<boolean>`${elenchDrafts.claimed_at} < now() - interval '${sql.raw(String(CLAIM_LEASE_SECONDS))} seconds'`;

/** The claim on a `sending` row (§2), or null for a row that holds none. */
export interface RowClaim {
	token: string;
	turnId: string;
	kind: ElenchDraftSendKind;
}

/** The claim a row holds: all four claim columns are set exactly when it is `sending` (§3.1). */
export function claimOf(row: ElenchDraft): RowClaim | null {
	if (
		row.status !== "sending" ||
		row.claim_token === null ||
		row.claim_turn_id === null ||
		row.claim_kind === null
	) {
		return null;
	}
	return { token: row.claim_token, turnId: row.claim_turn_id, kind: row.claim_kind };
}

/** The `thread` of §4.2 for a row, read in the caller's transaction against the row's own claim. */
async function threadOf(tx: Tx, actor: Actor, row: ElenchDraft): Promise<DraftThread> {
	const t = await readThread(tx, actor, row.conversation_id, row.claim_turn_id, row.text);
	return { status: t.status, firstTurnId: t.firstTurnId, hasTurn: t.hasTurn };
}

/** `not-claimed(row, thread)`: the request's token is not (or no longer) the row's claim. */
export async function notClaimedOf(
	tx: Tx,
	actor: Actor,
	row: ElenchDraft,
): Promise<DraftNotClaimed> {
	return { outcome: "not-claimed", row: toServerDraft(row), thread: await threadOf(tx, actor, row) };
}

/** `gone(thread)`: the key has no row. */
export async function goneOf(tx: Tx, actor: Actor, conversationId: string): Promise<DraftGone> {
	const t = await readThread(tx, actor, conversationId, null, "");
	return { outcome: "gone", thread: { status: t.status, firstTurnId: t.firstTurnId, hasTurn: t.hasTurn } };
}

/**
 * Whether the caller's live thread stores `turnId`, and with which text (§4.2's `hasTurn`, split
 * three ways): `same` when a message with that id has the same `turnText` as `text`, `different`
 * when the id is stored only with another text, `absent` when the id is not stored. `turnText` is
 * applied to BOTH sides, so a turn sent trimmed equals its untrimmed draft (B3).
 */
export async function storedTurn(
	tx: Tx,
	actor: Actor,
	conversationId: string,
	turnId: string,
	text: string,
): Promise<"same" | "different" | "absent"> {
	const [thread] = await tx
		.select({ messages: agentThreads.messages })
		.from(agentThreads)
		.where(
			and(
				eq(agentThreads.id, conversationId),
				eq(agentThreads.user_id, actor.userId), // authz-scope-ok: the caller's own threads only (ADR 0001 §4 step 5); owner_all alone admits the page org's rows
				ne(agentThreads.status, THREAD_DELETED),
			),
		)
		.limit(1);
	if (!thread) return "absent";
	const drafted: UIMessage = { id: turnId, role: "user", parts: [{ type: "text", text }] };
	const want = turnText(drafted);
	const withId = thread.messages.filter((m) => m.id === turnId);
	if (withId.length === 0) return "absent";
	return withId.some((m) => turnText(m) === want) ? "same" : "different";
}

/** What a claim's end writes besides clearing the claim: a release keeps the content, a consume empties it. */
export type ClaimEnd =
	| { end: "consume" }
	| { end: "release"; turnId: string | null; error: string; uncertain: boolean };

/**
 * Ends `claim` on its locked row (S3 or S4) and returns the row as written, or null when the row no
 * longer holds that claim (or, with `onlyIfSilent`, when it is no longer silent past the lease).
 * Either way the row goes back to `active` with the claim cleared and one more revision. A consume
 * empties the content and records `last_sent`; a release keeps the content and records the
 * failed-send marker.
 */
export async function endClaim(
	tx: Tx,
	actor: Actor,
	row: ElenchDraft,
	claim: RowClaim,
	how: ClaimEnd,
	onlyIfSilent = false,
): Promise<ElenchDraft | null> {
	const at = new Date().toISOString();
	const contentPatch =
		how.end === "consume"
			? {
					text: "",
					mentions: [],
					artifacts: [],
					cell_target: null,
					failed_send: null,
					last_sent: { turnId: claim.turnId, kind: claim.kind, at },
				}
			: {
					failed_send: {
						turnId: how.turnId,
						kind: claim.kind,
						error: how.error,
						at,
						uncertain: how.uncertain,
					},
				};
	const [updated] = await tx
		.update(elenchDrafts)
		.set({
			status: "active",
			claim_token: null,
			claim_turn_id: null,
			claim_kind: null,
			claimed_at: null,
			revision: row.revision + 1,
			updated_at: sql`now()`,
			...contentPatch,
		})
		.where(
			and(
				eq(elenchDrafts.id, row.id),
				eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), on top of owner_only RLS
				eq(elenchDrafts.org_id, actor.orgId),
				eq(elenchDrafts.status, "sending"),
				eq(elenchDrafts.claim_token, claim.token),
				onlyIfSilent ? claimIsSilent : undefined,
			),
		)
		.returning();
	return updated ?? null;
}

/**
 * The lease settle of one silent claim (S5). A first-turn claim is released: nothing here consumes
 * one, and from slice 5 `startConversation` (S2) will consume it only in the transaction that stores
 * its turn, so a first claim that reaches the lease is unsent. A later turn is consumed when the
 * thread stores it with this text; released with no turn id when the thread stores the id with
 * another text (that text can never be stored under that id, so the next claim mints a fresh one);
 * and released `uncertain` otherwise, because the route may have accepted it.
 */
async function settleSilent(
	tx: Tx,
	actor: Actor,
	row: ElenchDraft,
	claim: RowClaim,
): Promise<ElenchDraft> {
	let how: ClaimEnd;
	if (claim.kind === "first") {
		how = { end: "release", turnId: claim.turnId, error: LEASE_ERROR, uncertain: false };
	} else {
		const stored = await storedTurn(tx, actor, row.conversation_id, claim.turnId, row.text);
		how =
			stored === "same"
				? { end: "consume" }
				: stored === "different"
					? { end: "release", turnId: null, error: LEASE_ERROR, uncertain: false }
					: { end: "release", turnId: claim.turnId, error: LEASE_ERROR, uncertain: true };
	}
	return (await endClaim(tx, actor, row, claim, how, true)) ?? row;
}

/**
 * S5 for one locked row: settles its claim when it has been silent past the lease and the request
 * does NOT present its token (`presentedToken`, null for a request that carries none). Returns the
 * row as it now stands. A request holding the live token never settles its own claim.
 */
export async function settleIfSilent(
	tx: Tx,
	actor: Actor,
	row: ElenchDraft,
	presentedToken: string | null,
): Promise<ElenchDraft> {
	const claim = claimOf(row);
	if (claim === null || claim.token === presentedToken) return row;
	const [probe] = await tx
		.select({ silent: claimIsSilent })
		.from(elenchDrafts)
		.where(
			and(
				eq(elenchDrafts.id, row.id),
				eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), on top of owner_only RLS
				eq(elenchDrafts.org_id, actor.orgId),
			),
		)
		.limit(1);
	if (probe?.silent !== true) return row;
	return settleSilent(tx, actor, row, claim);
}

/**
 * S5 for a whole scope (`listDrafts`): locks every claim of the caller's `(org, anchor)` that has
 * been silent past the lease, and settles each. A list request carries no token, so none is spared.
 */
export async function settleScope(tx: Tx, actor: Actor, projectId: string | null): Promise<void> {
	const silent = await tx
		.select({ ...getTableColumns(elenchDrafts), silent: claimIsSilent })
		.from(elenchDrafts)
		.where(
			and(
				eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), on top of owner_only RLS
				eq(elenchDrafts.org_id, actor.orgId),
				projectId === null ? isNull(elenchDrafts.project_id) : eq(elenchDrafts.project_id, projectId),
				eq(elenchDrafts.status, "sending"),
				claimIsSilent,
			),
		)
		.for("update");
	for (const { silent: isSilent, ...row } of silent) {
		const claim = claimOf(row);
		if (isSilent === true && claim !== null) await settleSilent(tx, actor, row, claim);
	}
}

/**
 * S7, the heartbeat: renews `claimed_at` on the caller's row for `conversationId` when it is
 * `sending` under exactly `token`, and answers `touched`. Otherwise it writes nothing and answers
 * `not-claimed(row, thread)`, or `gone(thread)` when there is no row. It never settles anything:
 * the request presents a token, and a stale one must not end someone's claim from here.
 */
export async function touchClaim(
	tx: Tx,
	actor: Actor,
	conversationId: string,
	token: string,
): Promise<TouchClaimResult> {
	const [hit] = await tx
		.update(elenchDrafts)
		.set({ claimed_at: sql`now()` })
		.where(
			and(
				eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), on top of owner_only RLS
				eq(elenchDrafts.org_id, actor.orgId),
				eq(elenchDrafts.conversation_id, conversationId),
				eq(elenchDrafts.status, "sending"),
				eq(elenchDrafts.claim_token, token),
			),
		)
		.returning({ id: elenchDrafts.id });
	if (hit) return { outcome: "touched" };
	const [row] = await tx
		.select()
		.from(elenchDrafts)
		.where(
			and(
				eq(elenchDrafts.user_id, actor.userId), // authz-scope-ok: owner-only draft rows (ADR 0001 §3.1), on top of owner_only RLS
				eq(elenchDrafts.org_id, actor.orgId),
				eq(elenchDrafts.conversation_id, conversationId),
			),
		)
		.limit(1);
	if (!row) return goneOf(tx, actor, conversationId);
	return notClaimedOf(tx, actor, row);
}
