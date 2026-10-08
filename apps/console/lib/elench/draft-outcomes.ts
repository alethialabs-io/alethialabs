// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The outcomes of the Elench draft actions (ADR 0001 §4.2), as one module the client reducer can
// import without importing a `"use server"` file. Every action returns a discriminated union on
// `outcome` and never throws for an expected answer (§4 step 6).
//
// This file names every outcome of §4.2, including those of actions a later slice adds: the
// claim outcomes (`claimDraft`, `consumeDraft`, `releaseClaim`, the heartbeat route) are slice 4's,
// and the `startConversation` outcomes (§5.1) are slice 5's. Until those slices land, nothing
// returns them. Types only: nothing here runs.

import type { DraftContent } from "@/lib/elench/draft-content";
import type {
	ElenchDraftSendKind,
	ElenchFailedSend,
	ElenchLastSent,
} from "@/types/jsonb.types";

/** A draft row's state (§3.4): editable, frozen by a claim, or soft-discarded. */
export type DraftState = "active" | "sending" | "discarded";

/**
 * A key's thread status (ADR 0001 §2), read from `agent_threads` with the caller's own
 * `user_id`: no row, a live row with no messages, a live row with messages, or a tombstone.
 */
export type DraftThreadStatus = "none" | "unlisted" | "listed" | "deleted";

/**
 * What every refusal carries about the key's thread (§4.2), read in the same transaction as the
 * row it accompanies. `firstTurnId` is the id of the live row's first message, or null. `hasTurn`
 * is whether the live row holds a message whose id is the turn id the request names (the claim's,
 * or the row's `claim_turn_id`) and whose `turnText` equals that of the row's text.
 */
export interface DraftThread {
	status: DraftThreadStatus;
	firstTurnId: string | null;
	hasTurn: boolean;
}

/** A claim on a `sending` row (§2). The token is returned only to the row's own user, under RLS. */
export interface DraftClaim {
	token: string;
	turnId: string;
	kind: ElenchDraftSendKind;
	/** ISO-8601, the database clock. */
	claimedAt: string;
}

/**
 * A draft row as the server returns it (the client's `ServerDraft`, §7.1). The row id and the
 * user are never returned: the key is `(orgId, conversationId)` under the signed-in user.
 */
export interface ServerDraft {
	orgId: string;
	projectId: string | null;
	conversationId: string;
	revision: number;
	state: DraftState;
	content: DraftContent;
	claim: DraftClaim | null;
	failedSend: ElenchFailedSend | null;
	lastSent: ElenchLastSent | null;
	threadSeen: boolean;
	/** The last known thread title, for the Unsent label. */
	title: string | null;
	/** The opaque tab id of the last writer, used only to word a conflict. */
	lastWriter: string | null;
	/** ISO-8601, set exactly when `state` is `discarded`. */
	discardedAt: string | null;
	/** ISO-8601. */
	updatedAt: string;
}

/** One entry of `listDrafts`: the row, its thread, and the thread's title when one is live. */
export interface DraftListEntry {
	row: ServerDraft;
	thread: DraftThread;
	threadTitle: string | null;
}

// ── The refusals every action can answer (§4 steps 1-7) ─────────────────────────────────────────

/** The input failed its zod schema. Not retried (D28). */
export interface DraftInvalid {
	outcome: "invalid";
}

/** There is no session. Retried once after the viewer signs in again (D28). */
export interface DraftUnauthorized {
	outcome: "unauthorized";
}

/**
 * Refused. `membership` means the page's org no longer admits the caller (removed, suspended, or
 * the org is gone, §4 step 2); without a reason the authorization of the scope failed (§4 step 4),
 * which is the same answer for a project of another org and one that does not exist.
 */
export interface DraftForbidden {
	outcome: "forbidden";
	reason?: "membership";
}

/**
 * The write's org is not the page's. `other-org`: the key's org is not the actor's (§4 step 3), and
 * the client holds the write (D24). `address`: the page's slug no longer names the org, which still
 * exists for this user under `slug` (`~` for the personal org).
 */
export type DraftScopeChanged =
	| { outcome: "scope-changed"; reason: "other-org" }
	| { outcome: "scope-changed"; reason: "address"; slug: string };

/** Over the per-user rate. Transient (D27). */
export interface DraftRateLimited {
	outcome: "rate-limited";
}

/** A database error. Transient (D27). */
export interface DraftUnavailable {
	outcome: "unavailable";
}

/** Every refusal of §4's preamble, which any draft action can answer. */
export type DraftGateRefusal =
	| DraftInvalid
	| DraftUnauthorized
	| DraftForbidden
	| DraftScopeChanged
	| DraftRateLimited
	| DraftUnavailable;

// ── Row outcomes (§4.2) ──────────────────────────────────────────────────────────────────────────

/** A compare-and-set write landed; `revision` is the row's new revision. */
export interface DraftSaved {
	outcome: "saved";
	revision: number;
}

/** The row is not at the request's base revision (another tab or device wrote it). */
export interface DraftConflict {
	outcome: "conflict";
	row: ServerDraft;
	thread: DraftThread;
}

/** The row is frozen by a claim (`sending`); nothing was written. */
export interface DraftClaimed {
	outcome: "claimed";
	row: ServerDraft;
	thread: DraftThread;
}

/** The row is discarded (a refusal of `saveDraft` and `claimDraft`); nothing was written. */
export interface DraftDiscardedRefusal {
	outcome: "discarded";
	row: ServerDraft;
	thread: DraftThread;
}

/** `discardDraft` landed; `revision` is the discarded row's revision. */
export interface DraftDiscardedOk {
	outcome: "discarded";
	revision: number;
}

/** There is no row for the key, and the request named a base above 0. */
export interface DraftGone {
	outcome: "gone";
	thread: DraftThread;
}

/** A new row was refused because the scope already holds the bound of active drafts (§4.3). */
export interface DraftLimit {
	outcome: "limit";
}

/** `listDrafts`: the scope's drafts, in the page's org. */
export interface DraftListOk {
	outcome: "ok";
	orgId: string;
	drafts: DraftListEntry[];
}

// ── Claim outcomes (§3.4, §4.2): slice 4's actions answer these ──────────────────────────────────

/** S1 / S1r: this request's token holds the claim, at `revision`, on exactly `content`. */
export interface DraftClaimedByYou {
	outcome: "claimed-by-you";
	revision: number;
	content: DraftContent;
}

/** S1's kind guard failed: a `first` claim on a thread that exists, or a `later` one on none. */
export interface DraftWrongKind {
	outcome: "wrong-kind";
	thread: DraftThread;
}

/** S1: the content's text is empty after trim; nothing to send. */
export interface DraftEmpty {
	outcome: "empty";
}

/** S3 (or S4 redirected to S3): the claim became a turn; `revision` is the emptied row's. */
export interface DraftConsumed {
	outcome: "consumed";
	revision: number;
}

/** The request's token is no longer the row's: the claim was consumed, released or settled. */
export interface DraftNotClaimed {
	outcome: "not-claimed";
	row: ServerDraft;
	thread: DraftThread;
}

/** S4: the claim was released and the content kept, with the failed-send marker. */
export interface DraftReleased {
	outcome: "released";
	row: ServerDraft;
}

/** S7: the heartbeat renewed the claim. */
export interface DraftTouched {
	outcome: "touched";
}

// ── startConversation outcomes (§5.1): slice 5's action answers these ────────────────────────────

/** The thread was inserted with the first turn; the draft's and the thread's new revisions. */
export interface DraftStartCreated {
	outcome: "created";
	revision: number;
	threadRevision: number;
}

/** The thread already holds this turn as its first message: the start committed earlier. */
export interface DraftStartAlreadyStored {
	outcome: "already-stored";
	revision: number;
}

/** The conversation id names a tombstone. */
export interface DraftStartDeleted {
	outcome: "deleted";
	revision: number;
}

/** The conversation id names a thread this start cannot be the first turn of. */
export interface DraftStartConflict {
	outcome: "conflict";
	revision: number;
}

/** An external start found the draft row not at the revision it was sent with. */
export interface DraftStartDraftConflict {
	outcome: "draft-conflict";
	row: ServerDraft;
	thread: DraftThread;
}

// ── Per-action unions ───────────────────────────────────────────────────────────────────────────

/** What `listDrafts` answers. */
export type ListDraftsResult = DraftListOk | DraftGateRefusal;

/** What `saveDraft` answers (§4.2). */
export type SaveDraftResult =
	| DraftSaved
	| DraftConflict
	| DraftClaimed
	| DraftDiscardedRefusal
	| DraftGone
	| DraftLimit
	| DraftGateRefusal;

/** What `discardDraft` answers (§4.2). */
export type DiscardDraftResult =
	| DraftDiscardedOk
	| DraftConflict
	| DraftClaimed
	| DraftGone
	| DraftGateRefusal;

/** What `restoreDraft` answers (§4.2). */
export type RestoreDraftResult =
	| DraftSaved
	| DraftConflict
	| DraftGone
	| DraftGateRefusal;

/** What slice 4's `claimDraft` will answer (§4.2): its own outcomes plus the refusals of `saveDraft`. */
export type ClaimDraftResult =
	| DraftClaimedByYou
	| DraftClaimed
	| DraftConflict
	| DraftDiscardedRefusal
	| DraftGone
	| DraftWrongKind
	| DraftEmpty
	| DraftLimit
	| DraftGateRefusal;

/** What slice 4's `consumeDraft` will answer (§4.2). */
export type ConsumeDraftResult =
	| DraftConsumed
	| DraftNotClaimed
	| DraftGone
	| DraftGateRefusal;

/** What slice 4's `releaseClaim` will answer (§4.2). */
export type ReleaseClaimResult =
	| DraftReleased
	| DraftConsumed
	| DraftNotClaimed
	| DraftGone
	| DraftGateRefusal;

/** The body of a 200 from slice 4's heartbeat route (§4.2); its refusals are HTTP statuses. */
export type TouchClaimResult = DraftTouched | DraftNotClaimed | DraftGone;

/** What slice 5's `startConversation` will answer (§5.1). */
export type StartConversationResult =
	| DraftStartCreated
	| DraftStartAlreadyStored
	| DraftStartDeleted
	| DraftStartConflict
	| DraftStartDraftConflict
	| DraftNotClaimed
	| DraftClaimed
	| DraftGateRefusal;
