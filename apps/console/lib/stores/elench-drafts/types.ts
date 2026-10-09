// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The client side of Elench drafts (ADR 0001 §7): the per-key entry, the store state around it, and
// the events and effects of the drafting half of the reducer (reducer-drafting.ts). Types only.
//
// The entry carries every field of §7.1, including the send fields (`claiming`, `sending`,
// `abandoned`, `pendingFailedSend`). Nothing in this slice sets them: the transitions that do
// (D9-D13, D17, D18, D20-D22, D26, D30-D35) will be slice 7b's. The drafting reducer reads them only
// as guards (a frozen key is never autosaved, D7; the box is read-only while claiming, D5) and
// passes `pendingFailedSend` along with a save (D7, D8).

import type { DraftContent, DraftMention } from "@/lib/elench/draft-content";
import type {
	DraftThreadStatus,
	SaveDraftResult,
	RestoreDraftResult,
	ServerDraft,
} from "@/lib/elench/draft-outcomes";
import type { ElenchCellTarget, ElenchDraftSendKind } from "@/types/jsonb.types";

/**
 * Where a conversation lives: the org id the server resolved (never a slug) and the anchor, which
 * is the org (`projectId: null`) or one project (§2).
 */
export interface DraftScope {
	orgId: string;
	projectId: string | null;
}

/** A scope plus a conversation id: the immutable identity of one draft (I2). */
export interface DraftKey extends DraftScope {
	conversationId: string;
}

/**
 * A failed-send marker as the client sends it with `saveDraft` (§4.2): the server stamps `at`.
 * Only D10f (slice 7b) will create one.
 */
export interface PendingFailedSend {
	turnId: string | null;
	kind: ElenchDraftSendKind;
	error: string;
	uncertain: boolean;
}

/** A claim this tab asked for and has no answer to yet (§7.1). Set only by slice 7b (D9, D10). */
export interface DraftClaiming {
	attempt: string;
	token: string;
	turnId: string;
	kind: ElenchDraftSendKind;
	content: DraftContent;
}

/** Where a send of this tab is (§7.1). Set only by slice 7b. */
export type DraftSendPhase = "starting" | "routing" | "consuming" | "releasing";

/** A send this tab owns (§7.1). `token` is null for an external send, which takes no claim. */
export interface DraftSending {
	attempt: string;
	token: string | null;
	turnId: string;
	kind: ElenchDraftSendKind;
	text: string;
	mentions: DraftMention[];
	cellTarget: ElenchCellTarget | null;
	origin: string;
	at: number;
	phase: DraftSendPhase;
}

/**
 * Why a key is not saving (§7.4). `other-org` and `credential` are HELD (`save = "held"`): nothing is
 * wrong, and the key resumes by itself (D29) or on the user's answer (D36). The rest are BLOCKED.
 */
export type DraftBlockReason =
	| { kind: "other-org" }
	| { kind: "credential" }
	| { kind: "address"; slug: string }
	| { kind: "unauthorized" }
	| { kind: "forbidden"; membership: boolean }
	| { kind: "limit" }
	| { kind: "invalid" }
	| { kind: "error" };

/** The save state of one key (§7.1). */
export type DraftSaveState = "idle" | "saving" | "retrying" | "held" | "blocked";

/** An open conflict bar (§7.1). This slice opens `edited` (D15) and `discarded` (D16). */
export interface DraftConflictState {
	kind: "edited" | "discarded" | "gone" | "claimed" | "uncertain";
	row: ServerDraft | null;
}

/** The one `saveDraft` this key has on the wire: what was sent, so its answer can be read (D8). */
export interface DraftInflightSave {
	op: "save" | "restore";
	base: number;
	content: DraftContent;
	failedSend: PendingFailedSend | null;
}

/** One conversation's draft, as this tab holds it (ADR 0001 §7.1). */
export interface DraftEntry {
	/** Immutable (I2). */
	key: DraftKey;
	/** The last row the server returned; null when this tab has never seen one. */
	server: ServerDraft | null;
	/** Unacknowledged edits; null when the box shows exactly `server.content`. */
	local: DraftContent | null;
	/** Bumped only when the box content is replaced from outside (I6); an older EDIT is dropped. */
	epoch: number;
	claiming: DraftClaiming | null;
	sending: DraftSending | null;
	pendingFailedSend: PendingFailedSend | null;
	/** Tokens of this tab's own claims it gave up on (D32, D33). */
	abandoned: string[];
	save: DraftSaveState;
	blockedBy: DraftBlockReason | null;
	conflict: DraftConflictState | null;
	thread: DraftThreadStatus;
	/** Whether `useChat` holds this key's stored transcript. */
	transcript: "unloaded" | "loading" | "loaded";
	/** The request sequence number of the last write the server answered. */
	ackSeq: number;
	/** The write on the wire, if any (the per-key queue holds at most one). */
	inflight: DraftInflightSave | null;
	/** The user chose "Save to my account" on this key's credential notice (D36). */
	credentialAck: boolean;
	/** Consecutive transient failures, for D27's backoff; 0 after any answer that is not one. */
	transientFailures: number;
	/** Consecutive rejected calls that were not network failures; the fourth blocks (D27, D28). */
	errorFailures: number;
}

/** The drafts of this tab: every entry, the active key of each scope, and the page org (§7.1). */
export interface DraftsState {
	/** The signed-in viewer the entries belong to, or null when signed out (D25). */
	viewerId: string | null;
	/** The scope the surface shows, or null before the first one. */
	scope: DraftScope | null;
	/** Bumped on every scope change, so a late `listDrafts` answer for an older scope is dropped (D23). */
	generation: number;
	/** The org id of the page this tab shows, or null while it is not known (D29). */
	pageOrg: string | null;
	/** `scopeId(scope)` → the active conversation id of that scope. */
	activeKey: Record<string, string>;
	/** `keyId(key)` → the entry. */
	entries: Record<string, DraftEntry>;
}

/** Why a save is being asked for (D7). */
export type DraftSaveTrigger = "timer" | "blur" | "hidden" | "before-submit" | "retry" | "online";

/**
 * A rejected action call (§4 step 6): `network` is an offline or fetch failure, which is transient
 * (D27); anything else is an `error`, retried at most three times (D27) and then blocked (D28).
 */
export interface DraftRejection {
	network: boolean;
}

/** The events one entry reduces (the drafting half). */
export type DraftEntryEvent =
	/** D5 / D6 / D36: the editor yields its text and pills, stamped with the epoch it was seeded at. */
	| { type: "EDIT"; epoch: number; content: { text: string; mentions: DraftMention[] } }
	/** D7: the debounce, a blur, `visibilitychange: hidden`, a submit, a retry timer or `online`. */
	| { type: "SAVE_TRIGGER"; reason: DraftSaveTrigger }
	/** D8, D14-D16, D19, D24, D27, D28: the answer to this key's `saveDraft`, numbered `seq`. */
	| { type: "SAVE_RESULT"; seq: number; result: SaveDraftResult }
	/** D16's Restore: the answer to this key's `restoreDraft`, numbered `seq`. */
	| { type: "RESTORE_RESULT"; seq: number; result: RestoreDraftResult }
	/** D27 / D28: this key's write was rejected. */
	| { type: "WRITE_REJECTED"; seq: number; rejection: DraftRejection }
	/** D15: "Keep mine". */
	| { type: "CONFLICT_KEEP_MINE" }
	/** D15: "Use theirs". */
	| { type: "CONFLICT_USE_THEIRS" }
	/** D16: "Restore". */
	| { type: "CONFLICT_RESTORE" }
	/** D16: "Let it go". */
	| { type: "CONFLICT_LET_GO" }
	/** D19L: a `listDrafts` requested at `seq` no longer lists this key. */
	| { type: "NOT_LISTED"; seq: number }
	/** D36: "Save to my account". */
	| { type: "CREDENTIAL_ACK" }
	/** D28: a blocked key's one automatic retry (`unauthorized` after a sign-in, `limit` after room frees). */
	| { type: "UNBLOCK"; reason: "signed-in" | "limit-freed" }
	/** D4: `loadInto` finished for this key. */
	| { type: "TRANSCRIPT_LOADED" };

/** What the store passes every entry reduction: facts about the tab, never about the key. */
export interface DraftEntryContext {
	/** The page's org (D29). A write is sent only when the key's org is this one. */
	pageOrg: string | null;
	/** This page load's tab id (`last_writer`, D14s). */
	tabId: string;
	/** Whether the key is its scope's active key (D19). */
	active: boolean;
	/** ISO-8601, for the row this tab synthesizes when a first save is acknowledged (D8). */
	now: string;
}

/** The events of the store as a whole (the drafting half). */
export type DraftsEvent =
	/** D1 / D2: New chat, with a freshly minted conversation id the reducer may use. */
	| { type: "OPEN_NEW"; conversationId: string }
	/** D3: Open in new chat for an artifact, with a freshly minted conversation id. */
	| { type: "OPEN_ARTIFACT_NEW"; conversationId: string; artifactId: string }
	/** D4: the user picked a conversation; `thread` is its status when this tab holds no entry yet. */
	| { type: "SELECT"; key: DraftKey; thread: DraftThreadStatus }
	/** D23: an org switch or an anchor change. */
	| { type: "SCOPE_CHANGE"; scope: DraftScope }
	/** D29: the page's org, or null synchronously before a navigation that may change it. */
	| { type: "PAGE_ORG"; orgId: string | null }
	/** D25: the signed-in person changed (or signed out). */
	| { type: "VIEWER_CHANGE"; viewerId: string | null }
	/** Any per-key event, addressed to its key. */
	| { type: "ENTRY"; key: DraftKey; event: DraftEntryEvent };

/** The notices this half raises (§7.4); slice 11 will render them. */
export type DraftNotice =
	| "unsaved"
	| "held-other-org"
	| "blocked"
	| "credential"
	| "deleted-unsent-removed";

/** What the reducer asks the effects layer (slice 8) to do. It never does any of it itself. */
export type DraftEffect =
	| {
			type: "save";
			key: DraftKey;
			base: number;
			content: DraftContent;
			failedSend: PendingFailedSend | null;
	  }
	| { type: "restore"; key: DraftKey; base: number }
	/**
	 * Arm a timer that dispatches `SAVE_TRIGGER` with `reason` after `delayMs`: `timer` for D5's
	 * debounce, `retry` for D27's backoff (a `timer` trigger is ignored while retrying).
	 */
	| { type: "schedule-save"; key: DraftKey; delayMs: number; reason: "timer" | "retry" }
	| { type: "load-transcript"; key: DraftKey }
	| { type: "list"; scope: DraftScope; generation: number }
	| { type: "cache-remove"; key: DraftKey }
	| { type: "cache-clear" }
	| { type: "notice"; key: DraftKey; notice: DraftNotice };

/** One entry reduction: the next entry (null when the entry is removed) and its effects. */
export interface DraftEntryTransition {
	entry: DraftEntry | null;
	effects: DraftEffect[];
}

/** One store reduction. */
export interface DraftsTransition {
	state: DraftsState;
	effects: DraftEffect[];
}
