// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sending half of the Elench drafts reducer (ADR 0001 §7.2): D9-D13 (D10f included), D17, D18,
// D20-D22, D26 and D30-D35, and the claim-outcome table. Pure, like the drafting half: no I/O, no
// clock and no random ids. Every id it may need arrives in `SendContext.fresh`, minted by the caller
// for each dispatch, and everything it wants done comes back as an effect.
//
// It reads a claim's outcome only from the outcome and the `thread` and `last_sent` the server
// returned with it (§7.2's claim-outcome table, `readNotClaimed`), so it never guesses. Two reading
// rules are load-bearing and each has a mutation-checked test:
// - D34: a heartbeat's `not-claimed` or `gone` is read only while the send is still `routing` under
//   the same token. In any other phase a write of this claim is in flight and its own answer decides.
//   D22 reads a listed row against a live send by the same rule (R9, for the reason of B1').
// - D9b / D10y: a send's `metadata.cellTarget` is the claimed content's (or the external event's),
//   never the widget grid's pending slot, which this module cannot even see.
//
// Words never leave by accident (I3): a refused or failed send puts them back in the box (D10c,
// D11r, D10f), forks them into a new conversation (D18), or leaves them in the frozen row until a
// definitive answer arrives (D11, D11t). A consume (D9c, D12, D13, D17, D20) is the only way a send
// removes them.
//
// `reducer.ts` composes this with the drafting half. No caller yet: the effects layer (queue,
// cache, heartbeat timer, list) will be slice 8's, and the composer and conversation slice 9's.

import type { TurnRefusal } from "@/lib/agent/turn-claims";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";
import type { DraftContent, DraftMention } from "@/lib/elench/draft-content";
import type {
	ClaimDraftResult,
	ConsumeDraftResult,
	DiscardDraftResult,
	DraftListEntry,
	DraftThread,
	DraftThreadStatus,
	ReleaseClaimResult,
	SaveDraftResult,
	ServerDraft,
	StartConversationResult,
	TouchClaimResult,
} from "@/lib/elench/draft-outcomes";
import {
	contentEquals,
	EMPTY_CONTENT,
	isEmptyContent,
	normalizeEditorContent,
	reduceDraftEntry,
	retryDelayMs,
	shownContent,
} from "@/lib/stores/elench-drafts/reducer-drafting";
import type {
	DraftClaiming,
	DraftEffect,
	DraftEntry,
	DraftEntryContext,
	DraftEntryEvent,
	DraftEntryTransition,
	DraftKey,
	DraftNotice,
	DraftSending,
	PendingFailedSend,
} from "@/lib/stores/elench-drafts/types";
import type { ElenchCellTarget, ElenchDraftSendKind } from "@/types/jsonb.types";

// ── Types ────────────────────────────────────────────────────────────────────────────────────────

/** Fresh ids for one dispatch, minted by the caller; the reducer uses only the ones it needs. */
export interface FreshIds {
	attempt: string;
	token: string;
	turnId: string;
	conversationId: string;
}

/**
 * D10f's fence: the external send whose failed prompt a save put into the box, the box before it,
 * and the merged content that save carried, so a start that committed first takes the prompt back
 * out (D17) without touching words typed since.
 */
export interface DraftFence {
	turnId: string;
	before: DraftContent;
	merged: DraftContent;
}

/** What the store passes the sending half: the drafting context plus the facts a send needs. */
export interface SendContext extends DraftEntryContext {
	fresh: FreshIds;
	/** Whether the Elench surface is showing (D12: the first turn is pushed only into a mounted chat). */
	mounted: boolean;
	/** This key's D10f fence, if any. */
	fence: DraftFence | null;
}

/** How a queued draft write failed without an answer: rejected (D27) or abandoned at its timeout (D32). */
export type WriteFailure = { kind: "rejected"; network: boolean } | { kind: "timeout" };

/** How a chat request failed before `streaming` (D9d's event). */
export type RouteFailure =
	| { kind: "status"; status: number; refusal: TurnRefusal | null }
	| { kind: "network" }
	| { kind: "stop" }
	| { kind: "deadline" };

/** D9d's four arms. */
export type RouteFailureArm = "certain" | "uncertain" | "committed" | "different-text";

/** A cache item as D26 reads it (§7.3), already zod-validated by the effects layer. */
export interface CachedDraft {
	key: DraftKey;
	base: number;
	local: DraftContent | null;
	claiming: DraftClaiming | null;
	sending: DraftSending | null;
	abandoned: string[];
	epoch: number;
}

/** The per-key events of the sending half. */
export type DraftSendEvent =
	/** D9 / D9a / D10 / D10z: Enter on the box. `chatReady` is `status ∈ {ready, error}` (R3). */
	| { type: "SUBMIT"; chatReady: boolean }
	/** D10x / D10y / D10z: a suggestion, seed or empty-cell prompt, with its own text. */
	| {
			type: "SUBMIT_EXTERNAL";
			text: string;
			mentions: DraftMention[];
			cellTarget: ElenchCellTarget | null;
			origin: string;
			chatReady: boolean;
	  }
	/** D9b / D10b / D10c: the answer to this key's `claimDraft`. */
	| { type: "CLAIM_RESULT"; attempt: string; seq: number; result: ClaimDraftResult }
	/** D10c / D32: the claim was rejected or timed out. */
	| { type: "CLAIM_FAILED"; attempt: string; seq: number; failure: WriteFailure }
	/** D12 / D13 / D18 / D11 / D10f: the answer to `startConversation`. */
	| { type: "START_RESULT"; attempt: string; seq: number; result: StartConversationResult }
	/** D11 / D10f / D32: the start was rejected or timed out. */
	| { type: "START_FAILED"; attempt: string; seq: number; failure: WriteFailure }
	/** D9c: the turn's chat request reached `streaming` (or `data-turn-accepted`). */
	| { type: "ROUTE_HANDOFF"; turnId: string }
	/** D9d / D10f: the turn's chat request failed before `streaming`. */
	| { type: "ROUTE_FAILED"; turnId: string; failure: RouteFailure }
	/** D9c / D20: the answer to `consumeDraft`; `retry` is the attempt number the effect carried. */
	| { type: "CONSUME_RESULT"; token: string; seq: number; retry: number; result: ConsumeDraftResult }
	/** D32: a consume was rejected or timed out. */
	| { type: "CONSUME_FAILED"; token: string; seq: number; retry: number; failure: WriteFailure }
	/** D11r / D11c / D11n / D33 / D35: the answer to `releaseClaim`. */
	| { type: "RELEASE_RESULT"; token: string; seq: number; retry: number; result: ReleaseClaimResult }
	/** D11t: a release was rejected or timed out. */
	| { type: "RELEASE_FAILED"; token: string; seq: number; retry: number; failure: WriteFailure }
	/** D34: the heartbeat's 200 body. Its 401/403 stop the timer (slice 8) and never reach here. */
	| { type: "HEARTBEAT_RESULT"; token: string; result: TouchClaimResult }
	/** D21: Discard. */
	| { type: "DISCARD" }
	/** D21: the answer to `discardDraft` sent at `base`. */
	| { type: "DISCARD_RESULT"; base: number; seq: number; result: DiscardDraftResult }
	/** D21: the discard was rejected or timed out. */
	| { type: "DISCARD_FAILED" }
	/** D21's Undo toast: `restoreDraft` of the discarded row. */
	| { type: "UNDO_DISCARD"; revision: number; content: DraftContent }
	/** D31: the may-already-have-been-sent card's Dismiss. */
	| { type: "UNCERTAIN_DISMISS" }
	/** D9c: the copy-came-back bar's Keep it. */
	| { type: "COPY_KEEP" }
	/** D9c: the copy-came-back bar's Discard the copy. */
	| { type: "COPY_DISCARD" }
	/** D22: this key's row in a `listDrafts` answer requested at `seq`. */
	| { type: "LISTED"; seq: number; listed: DraftListEntry };

/** The notices this half raises (§7.4); slice 11 will render them. */
export type DraftSendNotice =
	| "not-sent"
	| "empty-box"
	| "wait-for-send"
	| "transcript-shown"
	| "first-sent"
	| "first-sent-more-in-box"
	| "sent-elsewhere"
	| "claimed-elsewhere"
	| "kept-in-new-deleted"
	| "kept-in-new-started"
	| "earlier-version-sent"
	| "being-answered"
	| "thread-busy"
	| "reload-to-continue"
	| "discard-conflict"
	| "discard-failed";

/** What the sending half asks the effects layer (slice 8) and the conversation (slice 9) to do. */
export type SendEffect =
	| Exclude<DraftEffect, { type: "notice" }>
	| { type: "notice"; key: DraftKey; notice: DraftNotice | DraftSendNotice }
	/** D9 / D10: `claimDraft`. This is the flush; there is no separate save. */
	| {
			type: "claim";
			key: DraftKey;
			attempt: string;
			base: number;
			content: DraftContent;
			turnId: string;
			token: string;
			kind: ElenchDraftSendKind;
	  }
	/** D10b (composer, `prompt` null: the text is read from the frozen row) / D10x (external). */
	| {
			type: "start";
			key: DraftKey;
			attempt: string;
			turnId: string;
			revision: number;
			origin: string;
			token: string | null;
			prompt: { text: string; mentions: DraftMention[]; cellTarget: ElenchCellTarget | null } | null;
	  }
	/**
	 * D9b / D10y / D12: stage `mentions` in the `pendingMentions` slot, then `sendMessage({ id: turnId,
	 * parts: [{ type: "text", text }], metadata: { mentions, cellTarget } })`. `text` is trimmed.
	 */
	| {
			type: "send-message";
			key: DraftKey;
			turnId: string;
			text: string;
			mentions: DraftMention[];
			cellTarget: ElenchCellTarget | null;
	  }
	/** D9d / D10f: remove the optimistic user message `turnId` from `useChat`. */
	| { type: "remove-optimistic"; key: DraftKey; turnId: string }
	/** D9c / D20: `consumeDraft(token)`, after `delayMs` (D27's backoff on a retry). */
	| { type: "consume"; key: DraftKey; token: string; retry: number; delayMs: number }
	/** D11 / D9d / D26 / D33: `releaseClaim`, after `delayMs` (D11t's backoff on a retry). */
	| {
			type: "release";
			key: DraftKey;
			token: string;
			error: string;
			uncertain: boolean;
			freshTurnId: string | null;
			retry: number;
			delayMs: number;
	  }
	/** D21 / D18: `discardDraft(base)`. */
	| { type: "discard"; key: DraftKey; base: number }
	/** D21: the Undo toast, which dispatches `UNDO_DISCARD` with these. */
	| { type: "offer-undo-discard"; key: DraftKey; revision: number; content: DraftContent }
	/** D31 / D9c: `saveDraft(base, content, dismissFailedSend: true)`, answered as a save. */
	| { type: "dismiss-failed-send"; key: DraftKey; base: number; content: DraftContent }
	/** D12: seed the transport's base revision (slice 9 wires 0003/6's setter). */
	| { type: "thread-revision"; key: DraftKey; revision: number }
	/** D12: place the pending Open-in-new-chat artifacts into the new conversation. */
	| { type: "place-artifacts"; key: DraftKey; artifacts: string[] }
	/** D20: poll `getThread` every 5 s until its `inFlight` is null, then load again. */
	| { type: "poll-thread"; key: DraftKey };

/**
 * D18's FORK, which the store applies: a new key in the same scope (`fresh.conversationId`) whose
 * content is `content`, saved at base 0; once saved, the old key's row is discarded at `discard`.
 */
export interface DraftFork {
	content: DraftContent;
	discard: number | null;
	notice: "kept-in-new-deleted" | "kept-in-new-started";
}

/**
 * One sending-half reduction. `entry` is the key's next entry: with a `fork`, it is what the key
 * keeps if the store cannot fork (it still holds the words), and the store removes it otherwise.
 * `fence` undefined keeps the key's fence, null clears it, and a value sets it.
 */
export interface SendEntryTransition {
	entry: DraftEntry | null;
	effects: SendEffect[];
	fork?: DraftFork;
	fence?: DraftFence | null;
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

/** No change. */
function none(entry: DraftEntry): SendEntryTransition {
	return { entry, effects: [] };
}

/** A notice effect. */
function notice(key: DraftKey, n: DraftNotice | DraftSendNotice): SendEffect {
	return { type: "notice", key, notice: n };
}

/** A transition with `effects` put in front of its own. */
function prepend(effects: SendEffect[], t: SendEntryTransition): SendEntryTransition {
	return { ...t, effects: [...effects, ...t.effects] };
}

/** Records the sequence number of a write the server answered (D22 reads it). */
function acked(entry: DraftEntry, seq: number): DraftEntry {
	return { ...entry, ackSeq: Math.max(entry.ackSeq, seq) };
}

/** Removes a token from `abandoned` (D33: on `released` or `not-claimed`). */
function forget(entry: DraftEntry, token: string): DraftEntry {
	return entry.abandoned.includes(token)
		? { ...entry, abandoned: entry.abandoned.filter((t) => t !== token) }
		: entry;
}

/** Bumps the epoch when the box now shows something else than before: replaced from outside (I6). */
function withEpoch(before: DraftEntry, after: DraftEntry): DraftEntry {
	return contentEquals(shownContent(before), shownContent(after))
		? after
		: { ...after, epoch: before.epoch + 1 };
}

/** The content of `head` followed by `"\n\n"` and `tail` (D10f, D11r, D18), spans re-based. */
export function appendContent(head: DraftContent, tail: DraftContent | null): DraftContent {
	if (tail === null || isEmptyContent(tail)) return head;
	const sep = head.text === "" || tail.text === "" ? "" : "\n\n";
	const offset = head.text.length + sep.length;
	return {
		text: head.text + sep + tail.text,
		mentions: [
			...head.mentions,
			...tail.mentions.map((m) => ({ ...m, start: m.start + offset, end: m.end + offset })),
		],
		artifacts: [...head.artifacts, ...tail.artifacts.filter((a) => !head.artifacts.includes(a))],
		cellTarget: head.cellTarget ?? tail.cellTarget,
	};
}

/** The text a send stores (`text.trim()`, as every send trims), with its spans re-based onto it. */
function trimForSend(
	text: string,
	mentions: DraftMention[],
): { text: string; mentions: DraftMention[] } {
	const lead = text.length - text.trimStart().length;
	const trimmed = text.trim();
	return {
		text: trimmed,
		mentions: mentions
			.map((m) => ({ ...m, start: m.start - lead, end: m.end - lead }))
			.filter((m) => m.start >= 0 && m.end <= trimmed.length),
	};
}

/** A server row of this key, from the last one seen (or an empty one), with `over` applied. */
function rowOf(entry: DraftEntry, ctx: SendContext, over: Partial<ServerDraft>): ServerDraft {
	const prev = entry.server;
	return {
		orgId: entry.key.orgId,
		projectId: entry.key.projectId,
		conversationId: entry.key.conversationId,
		revision: prev?.revision ?? 0,
		state: prev?.state ?? "active",
		content: prev?.content ?? EMPTY_CONTENT,
		claim: prev?.claim ?? null,
		failedSend: prev?.failedSend ?? null,
		lastSent: prev?.lastSent ?? null,
		threadSeen: prev?.threadSeen ?? false,
		title: prev?.title ?? null,
		lastWriter: prev?.lastWriter ?? null,
		discardedAt: prev?.discardedAt ?? null,
		updatedAt: ctx.now,
		...over,
	};
}

/**
 * Runs a drafting event. While D31's card is open (`uncertain` with no row) the card is not a
 * conflict to resolve: edits still autosave, and `saveDraft` keeps the marker (R10). Every other bar
 * stops the autosave, as D15/D16/D30 require.
 */
export function reduceDraftingEvent(
	entry: DraftEntry,
	event: DraftEntryEvent,
	ctx: DraftEntryContext,
): DraftEntryTransition {
	const card = entry.conflict;
	if (card === null || card.kind !== "uncertain" || card.row !== null)
		return reduceDraftEntry(entry, event, ctx);
	const open: DraftEntry = { ...entry, conflict: null };
	const t = reduceDraftEntry(open, event, ctx);
	if (t.entry === open) return { entry, effects: t.effects }; // unchanged: the very same entry
	if (t.entry === null || t.entry.conflict !== null) return t;
	return { entry: { ...t.entry, conflict: card }, effects: t.effects };
}

/** D7 now, if nothing forbids it: the drafting half's own `trySave`, reached through its event. */
function saveNow(entry: DraftEntry, ctx: SendContext): SendEntryTransition {
	return reduceDraftingEvent(entry, { type: "SAVE_TRIGGER", reason: "before-submit" }, ctx);
}

/** Saves `entry` now when it holds unsaved words; otherwise no change. */
function saveIfDirty(t: SendEntryTransition, ctx: SendContext): SendEntryTransition {
	if (t.entry === null || t.entry.local === null) return t;
	return prepend(t.effects, { ...saveNow(t.entry, ctx), fork: t.fork, fence: t.fence });
}

/**
 * Reads a claim's (or a discard's) refusal exactly as the drafting half reads a save's (D10c: "the
 * outcome then takes its own transition", D14-D16, D24, D27, D28): through a save of the box.
 */
function readAsSave(
	entry: DraftEntry,
	seq: number,
	result: SaveDraftResult,
	ctx: SendContext,
): SendEntryTransition {
	const content = entry.local ?? EMPTY_CONTENT;
	const asSent: DraftEntry = {
		...entry,
		inflight: { op: "save", base: entry.server?.revision ?? 0, content, failedSend: null },
	};
	return reduceDraftingEvent(asSent, { type: "SAVE_RESULT", seq, result }, ctx);
}

/** Loads the transcript and bumps the lineage, or marks it unloaded when no chat is mounted (D9a). */
function reload(entry: DraftEntry, ctx: SendContext): SendEntryTransition {
	if (ctx.active && ctx.mounted)
		return {
			entry: { ...entry, transcript: "loading" },
			effects: [{ type: "load-transcript", key: entry.key }],
		};
	return { entry: { ...entry, transcript: "unloaded" }, effects: [] };
}

/**
 * Sets the thread status an outcome carried (§4.2). When it changes from `none`/`deleted` to
 * `listed`/`unlisted`, the transcript is loaded (D22), so no send runs from an empty `useChat` (I7).
 */
function withThread(
	entry: DraftEntry,
	status: DraftThreadStatus,
	ctx: SendContext,
): SendEntryTransition {
	if (status === entry.thread) return none(entry);
	const wasEmpty = entry.thread === "none" || entry.thread === "deleted";
	const stored = status === "listed" || status === "unlisted";
	const next: DraftEntry = { ...entry, thread: status };
	return wasEmpty && stored ? reload(next, ctx) : none(next);
}

/** A release effect. */
function releaseEffect(
	key: DraftKey,
	token: string,
	error: string,
	uncertain: boolean,
	freshTurnId: string | null,
	retry: number,
): SendEffect {
	return {
		type: "release",
		key,
		token,
		error,
		uncertain,
		freshTurnId,
		retry,
		delayMs: retry === 0 ? 0 : retryDelayMs(retry),
	};
}

/** A consume effect. */
function consumeEffect(key: DraftKey, token: string, retry: number): SendEffect {
	return { type: "consume", key, token, retry, delayMs: retry === 0 ? 0 : retryDelayMs(retry) };
}

/** True when the outcome proves this claim's send was consumed (the claim-outcome table). */
function sentProven(row: ServerDraft, thread: DraftThread, turnId: string): boolean {
	return row.lastSent?.turnId === turnId || thread.firstTurnId === turnId || thread.hasTurn;
}

/** The words a send carries into a fork (D18): its text and pills, then the box, and the artifacts. */
function sendingWords(entry: DraftEntry, sending: DraftSending): DraftContent {
	const external = sending.token === null;
	const head: DraftContent = {
		text: sending.text,
		mentions: sending.mentions,
		artifacts: external ? [] : (entry.server?.content.artifacts ?? []),
		cellTarget: null,
	};
	// Then the box's unsaved words. An external send's own row is never discarded (no claim took it),
	// so its acknowledged draft stays on the server under this key.
	return appendContent(head, entry.local);
}

/**
 * D18: FORK. The store moves `content` into a new key and saves it at base 0. The returned entry is
 * what this key keeps if it cannot (the words, in the box): never a state without them.
 */
function fork(
	entry: DraftEntry,
	content: DraftContent,
	discard: number | null,
	n: DraftFork["notice"],
): SendEntryTransition {
	const fallback: DraftEntry = {
		...entry,
		claiming: null,
		sending: null,
		local: content,
		epoch: entry.epoch + 1,
	};
	return { entry: fallback, effects: [], fork: { content, discard, notice: n } };
}

// ── D9 / D9a / D10 / D10x / D10y / D10z: submitting ──────────────────────────────────────────────

/** The `claim` effect of a claim this key holds. */
function claimEffect(entry: DraftEntry, claiming: DraftClaiming): SendEffect {
	return {
		type: "claim",
		key: entry.key,
		attempt: claiming.attempt,
		base: entry.server?.revision ?? 0,
		content: claiming.content,
		turnId: claiming.turnId,
		token: claiming.token,
		kind: claiming.kind,
	};
}

/** D9a: a stored thread whose transcript this tab does not hold: load it, send nothing. */
function loadFirst(entry: DraftEntry, ctx: SendContext): SendEntryTransition {
	const t = reload(entry, ctx);
	return { entry: t.entry, effects: [...t.effects, notice(entry.key, "transcript-shown")] };
}

/**
 * D9 / D10: Enter claims the box at the revision it shows, and empties `local`: the box now shows
 * the claimed content, read-only, and only text typed after the claim answers is `local` (R1). The
 * turn id is the failed-send marker's when there is one (D10f, D31), so a re-send names one turn.
 */
function submit(entry: DraftEntry, chatReady: boolean, ctx: SendContext): SendEntryTransition {
	if (entry.claiming !== null || entry.sending !== null)
		return { entry, effects: [notice(entry.key, "wait-for-send")] }; // D10z
	if (entry.conflict !== null && entry.conflict.kind !== "uncertain") return none(entry); // D31 allows
	if (ctx.pageOrg !== entry.key.orgId) return none(entry); // D29, I8: never from another org's page
	const content = shownContent(entry);
	if (content.text.trim() === "") return { entry, effects: [notice(entry.key, "empty-box")] };
	if (content.text.length > MAX_USER_MESSAGE_CHARS) return none(entry);
	const stored = entry.thread === "listed" || entry.thread === "unlisted";
	if (stored && entry.transcript !== "loaded") return loadFirst(entry, ctx); // D9a
	if (stored && !chatReady) return none(entry); // R3
	const claiming: DraftClaiming = {
		attempt: ctx.fresh.attempt,
		token: ctx.fresh.token,
		turnId:
			entry.server?.failedSend?.turnId ?? entry.pendingFailedSend?.turnId ?? ctx.fresh.turnId,
		kind: stored ? "later" : "first",
		content,
	};
	const next: DraftEntry = { ...entry, claiming, local: null, conflict: null };
	// A save already on the wire is answered first; the claim then goes at the base it acknowledges.
	if (entry.inflight !== null) return none(next);
	return { entry: next, effects: [claimEffect(next, claiming)] };
}

/** D10x / D10y: an external prompt takes no claim; the entry exists so the send has an owner. */
function submitExternal(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "SUBMIT_EXTERNAL" }>,
	ctx: SendContext,
): SendEntryTransition {
	if (entry.claiming !== null || entry.sending !== null)
		return { entry, effects: [notice(entry.key, "wait-for-send")] }; // D10z
	if (ctx.pageOrg !== entry.key.orgId) return none(entry);
	const prompt = normalizeEditorContent({ text: ev.text, mentions: ev.mentions });
	if (prompt.text.trim() === "" || prompt.text.length > MAX_USER_MESSAGE_CHARS) return none(entry);
	const stored = entry.thread === "listed" || entry.thread === "unlisted";
	const sending: DraftSending = {
		attempt: ctx.fresh.attempt,
		token: null,
		turnId: ctx.fresh.turnId,
		kind: stored ? "later" : "first",
		text: prompt.text,
		mentions: prompt.mentions,
		cellTarget: ev.cellTarget,
		origin: ev.origin,
		at: Date.parse(ctx.now),
		phase: stored ? "routing" : "starting",
	};
	if (!stored) {
		// D10x
		if (entry.server?.state === "sending") return none(entry);
		return {
			entry: { ...entry, sending },
			effects: [
				{
					type: "start",
					key: entry.key,
					attempt: sending.attempt,
					turnId: sending.turnId,
					revision: entry.server?.revision ?? 0,
					origin: ev.origin,
					token: null,
					prompt: { text: prompt.text, mentions: prompt.mentions, cellTarget: ev.cellTarget },
				},
			],
		};
	}
	// D10y
	if (entry.transcript !== "loaded") return loadFirst(entry, ctx);
	if (!ev.chatReady) return { entry, effects: [notice(entry.key, "wait-for-send")] };
	const sent = trimForSend(prompt.text, prompt.mentions);
	return {
		entry: { ...entry, sending },
		effects: [
			{
				type: "send-message",
				key: entry.key,
				turnId: sending.turnId,
				text: sent.text,
				mentions: sent.mentions,
				cellTarget: ev.cellTarget, // from the event (ADR 0003 §9.4 change 3), never the slot
			},
		],
	};
}

// ── D9b / D10b / D10c: the claim's answer ────────────────────────────────────────────────────────

/** D10c: the claimed words go back into the box, editable again; nothing is sent. */
function unclaim(entry: DraftEntry, claiming: DraftClaiming): DraftEntry {
	const same = entry.server !== null && contentEquals(claiming.content, entry.server.content);
	return { ...entry, claiming: null, local: same ? null : claiming.content };
}

/**
 * D9b / D10b: the claim is ours. The sent text, pills and cell target are the CLAIMED content's
 * (never the widget grid's pending slot), the box empties, and the send starts: a later turn goes to
 * the chat route, a first turn to `startConversation`, which reads the text from the frozen row.
 */
function granted(
	entry: DraftEntry,
	claiming: DraftClaiming,
	revision: number,
	ctx: SendContext,
): SendEntryTransition {
	const content = claiming.content;
	const sending: DraftSending = {
		attempt: claiming.attempt,
		token: claiming.token,
		turnId: claiming.turnId,
		kind: claiming.kind,
		text: content.text,
		mentions: content.mentions,
		cellTarget: content.cellTarget,
		origin: "composer",
		at: Date.parse(ctx.now),
		phase: claiming.kind === "later" ? "routing" : "starting",
	};
	const server = rowOf(entry, ctx, {
		revision,
		state: "sending",
		content,
		claim: { token: claiming.token, turnId: claiming.turnId, kind: claiming.kind, claimedAt: ctx.now },
		failedSend: null,
	});
	const next: DraftEntry = {
		...entry,
		claiming: null,
		sending,
		server,
		pendingFailedSend: null,
		epoch: entry.epoch + 1,
	};
	if (claiming.kind === "later") {
		const sent = trimForSend(content.text, content.mentions);
		return {
			entry: next,
			effects: [
				{
					type: "send-message",
					key: entry.key,
					turnId: claiming.turnId,
					text: sent.text,
					mentions: sent.mentions,
					cellTarget: content.cellTarget,
				},
			],
		};
	}
	return {
		entry: next,
		effects: [
			{
				type: "start",
				key: entry.key,
				attempt: claiming.attempt,
				turnId: claiming.turnId,
				revision,
				origin: "composer",
				token: claiming.token,
				prompt: null,
			},
		],
	};
}

/** D30 / D33: the row is frozen under a token that is not this send's. */
function claimedElsewhere(
	entry: DraftEntry,
	row: ServerDraft,
	thread: DraftThread,
	ctx: SendContext,
): SendEntryTransition {
	const t = withThread(entry, thread.status, ctx);
	if (t.entry === null) return t;
	const token = row.claim?.token ?? null;
	if (token !== null && t.entry.abandoned.includes(token))
		// D33: this tab's own abandoned claim, never another tab's.
		return { entry: t.entry, effects: [...t.effects, releaseEffect(entry.key, token, "abandoned", false, null, 0)] };
	// D30: read-only, and the box keeps whatever it shows (an unsaved `local` is kept, I5).
	const entering = t.entry.conflict?.kind !== "claimed";
	const next = withEpoch(entry, { ...t.entry, server: row, conflict: { kind: "claimed", row } });
	return {
		entry: next,
		effects: entering ? [...t.effects, notice(entry.key, "claimed-elsewhere")] : t.effects,
	};
}

/** The answer to this key's `claimDraft` (D9b, D10b, D10c). */
function claimResult(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "CLAIM_RESULT" }>,
	ctx: SendContext,
): SendEntryTransition {
	const claiming = entry.claiming;
	if (claiming === null || claiming.attempt !== ev.attempt) return none(entry);
	const e = acked(entry, ev.seq);
	const r = ev.result;
	if (r.outcome === "claimed-by-you") return granted(e, claiming, r.revision, ctx);
	const back = unclaim(e, claiming);
	const notSent = [notice(entry.key, "not-sent")];
	switch (r.outcome) {
		case "wrong-kind":
			return prepend(notSent, withThread(back, r.thread.status, ctx));
		case "empty":
			return { entry: back, effects: notSent };
		case "claimed":
			return prepend(notSent, claimedElsewhere(back, r.row, r.thread, ctx));
		case "gone":
			// D18: the conversation's row is gone; the words the user pressed Enter on move on.
			return fork({ ...back, thread: r.thread.status }, claiming.content, null, "kept-in-new-deleted");
		default:
			return prepend(notSent, readAsSave(back, ev.seq, r, ctx));
	}
}

/** D10c / D32: the claim was rejected, or abandoned at its timeout (then it may have landed: D33). */
function claimFailed(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "CLAIM_FAILED" }>,
	ctx: SendContext,
): SendEntryTransition {
	const claiming = entry.claiming;
	if (claiming === null || claiming.attempt !== ev.attempt) return none(entry);
	const back = unclaim(entry, claiming);
	const notSent = notice(entry.key, "not-sent");
	if (ev.failure.kind === "timeout") {
		const abandoned = { ...back, abandoned: [...back.abandoned, claiming.token] };
		return {
			entry: abandoned,
			effects: [notSent, releaseEffect(entry.key, claiming.token, "timeout", false, null, 0)],
		};
	}
	// A rejected call: read as the drafting half reads a rejected save (D27, D28).
	const asSent: DraftEntry = {
		...back,
		inflight: { op: "save", base: back.server?.revision ?? 0, content: back.local ?? EMPTY_CONTENT, failedSend: null },
	};
	const t = reduceDraftingEvent(asSent, { type: "WRITE_REJECTED", seq: ev.seq, rejection: { network: ev.failure.network } }, ctx);
	return prepend([notSent], t);
}

// ── D11 / D11r / D11c / D11n / D11t / D17 / D9c: a claim's later answers ─────────────────────────

/** D9c's `consumed` arm: the later turn's claim is consumed; text typed meanwhile saves at `r`. */
function consumedArm(
	entry: DraftEntry,
	sending: DraftSending,
	row: ServerDraft | null,
	revision: number,
	ctx: SendContext,
): SendEntryTransition {
	const server =
		row ??
		rowOf(entry, ctx, {
			revision,
			state: "active",
			content: EMPTY_CONTENT,
			claim: null,
			failedSend: null,
			lastSent: { turnId: sending.turnId, kind: sending.kind, at: ctx.now },
		});
	const base = sending.token === null ? entry : forget(entry, sending.token);
	const next = withEpoch(entry, { ...base, sending: null, server });
	return saveIfDirty(none(next), ctx);
}

/**
 * D17: a first send of this tab is learned to be committed. The box holds only `local`, the text
 * typed after the claim; it never holds the sent text (G31). No auto-send: the transcript is loaded.
 */
function committedFirst(
	entry: DraftEntry,
	sending: DraftSending,
	row: ServerDraft | null,
	ctx: SendContext,
): SendEntryTransition {
	const base = sending.token === null ? entry : forget(entry, sending.token);
	const server =
		row ??
		rowOf(entry, ctx, {
			state: "active",
			content: EMPTY_CONTENT,
			claim: null,
			lastSent: { turnId: sending.turnId, kind: "first", at: ctx.now },
		});
	const next = withEpoch(entry, { ...base, sending: null, server, thread: "listed" });
	const t = reload(next, ctx);
	const n = notice(entry.key, entry.local === null ? "first-sent" : "first-sent-more-in-box");
	return saveIfDirty({ entry: t.entry, effects: [...t.effects, n] }, ctx);
}

/**
 * D11r / D11n: the release is definitive, so the start or the route can no longer consume this
 * claim. Only now do the words go back into the box: `row.text`, then any text typed after the claim.
 * A later turn into a thread that was deleted meanwhile forks instead (D18).
 */
function releasedBack(
	entry: DraftEntry,
	sending: DraftSending,
	row: ServerDraft,
	ctx: SendContext,
): SendEntryTransition {
	const base = sending.token === null ? entry : forget(entry, sending.token);
	if (sending.kind === "later" && entry.thread === "deleted")
		return fork(base, sendingWords(base, sending), row.revision, "kept-in-new-deleted");
	const merged = entry.local === null ? null : appendContent(row.content, entry.local);
	const uncertain = row.failedSend?.uncertain === true;
	const next: DraftEntry = {
		...base,
		sending: null,
		server: row,
		local: merged,
		epoch: entry.epoch + 1,
		conflict: uncertain ? { kind: "uncertain", row: null } : entry.conflict, // D31's card, not "Not sent"
	};
	const t = saveIfDirty(none(next), ctx);
	return uncertain ? t : prepend([notice(entry.key, "not-sent")], t);
}

/** The claim-outcome table's `not-claimed(row, thread)`: consumed (D17 / D9c) or released (D11n). */
function readNotClaimed(
	entry: DraftEntry,
	sending: DraftSending,
	row: ServerDraft,
	thread: DraftThread,
	ctx: SendContext,
): SendEntryTransition {
	const t = withThread(entry, thread.status, ctx);
	if (t.entry === null) return t;
	if (sentProven(row, thread, sending.turnId))
		return prepend(
			t.effects,
			sending.kind === "first"
				? committedFirst(t.entry, sending, row, ctx)
				: consumedArm(t.entry, sending, row, row.revision, ctx),
		);
	if (row.state === "sending") {
		// The lease released this claim and another tab claimed the words: they are being sent there.
		const freed = sending.token === null ? t.entry : forget(t.entry, sending.token);
		return prepend(t.effects, claimedElsewhere({ ...freed, sending: null }, row, thread, ctx));
	}
	return prepend(t.effects, releasedBack(t.entry, sending, row, ctx)); // D11n
}

/** D11: the start (or the route) failed; release by token and wait for a definitive answer. */
function releaseNow(
	entry: DraftEntry,
	sending: DraftSending,
	error: string,
	uncertain: boolean,
	freshTurnId: string | null,
): SendEntryTransition {
	if (sending.token === null) return none(entry);
	return {
		entry: { ...entry, sending: { ...sending, phase: "releasing" } },
		effects: [releaseEffect(entry.key, sending.token, error, uncertain, freshTurnId, 0)],
	};
}

// ── D10f: an external send failed ────────────────────────────────────────────────────────────────

/**
 * D10f: the prompt goes into the box, and the save that puts it there fences the send: the box shows
 * the prompt, then what it held, with the prompt's cell target and the failed-send marker.
 */
function failExternal(
	entry: DraftEntry,
	sending: DraftSending,
	error: string,
	uncertain: boolean,
	ctx: SendContext,
): SendEntryTransition {
	const before = entry.local ?? entry.server?.content ?? EMPTY_CONTENT;
	const prompt: DraftContent = {
		text: sending.text,
		mentions: sending.mentions,
		artifacts: [],
		cellTarget: sending.cellTarget,
	};
	const merged: DraftContent = { ...appendContent(prompt, before), cellTarget: sending.cellTarget };
	const marker: PendingFailedSend = { turnId: sending.turnId, kind: sending.kind, error, uncertain };
	const next: DraftEntry = {
		...entry,
		sending: null,
		local: merged,
		pendingFailedSend: marker,
		epoch: entry.epoch + 1,
		conflict: uncertain ? { kind: "uncertain", row: null } : entry.conflict,
	};
	const t = saveNow(next, ctx);
	const effects = uncertain ? t.effects : [notice(entry.key, "not-sent"), ...t.effects];
	return { entry: t.entry, effects, fence: { turnId: sending.turnId, before, merged } };
}

// ── D12 / D13 / D18 / D11: the start's answer ────────────────────────────────────────────────────

/** D12 / D13: the first turn is stored and the claim consumed in the same transaction. */
function started(
	entry: DraftEntry,
	sending: DraftSending,
	revision: number,
	threadRevision: number | null,
	ctx: SendContext,
): SendEntryTransition {
	const external = sending.token === null;
	// An external start leaves the draft's content as it was (§5.1 step 4); a composer start empties it.
	const server = external
		? rowOf(entry, ctx, { revision, failedSend: null, threadSeen: true })
		: rowOf(entry, ctx, {
				revision,
				state: "active",
				content: EMPTY_CONTENT,
				claim: null,
				failedSend: null,
				threadSeen: true,
				lastSent: { turnId: sending.turnId, kind: "first", at: ctx.now },
			});
	const artifacts = external ? [] : (entry.server?.content.artifacts ?? []);
	const base = external || sending.token === null ? entry : forget(entry, sending.token);
	const next = withEpoch(entry, { ...base, sending: null, server, thread: "listed" });
	const effects: SendEffect[] = [];
	let t: SendEntryTransition;
	if (threadRevision === null) {
		// D13: already stored. Load it; never send it again (§5.2).
		t = reload(next, ctx);
	} else {
		// D12
		t = none({ ...next, transcript: "loaded" });
		effects.push({ type: "thread-revision", key: entry.key, revision: threadRevision });
		if (ctx.active && ctx.mounted) {
			const sent = trimForSend(sending.text, sending.mentions);
			effects.push({
				type: "send-message",
				key: entry.key,
				turnId: sending.turnId,
				text: sent.text,
				mentions: sent.mentions,
				cellTarget: sending.cellTarget,
			});
		}
	}
	if (artifacts.length > 0) effects.push({ type: "place-artifacts", key: entry.key, artifacts });
	return saveIfDirty({ entry: t.entry, effects: [...t.effects, ...effects] }, ctx);
}

/** The answer to `startConversation` (D12, D13, D18, D11, D10f). */
function startResult(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "START_RESULT" }>,
	ctx: SendContext,
): SendEntryTransition {
	const sending = entry.sending;
	if (sending === null || sending.attempt !== ev.attempt || sending.phase !== "starting")
		return none(entry);
	const e = acked(entry, ev.seq);
	const r = ev.result;
	switch (r.outcome) {
		case "created":
			return started(e, sending, r.revision, r.threadRevision, ctx);
		case "already-stored":
			return started(e, sending, r.revision, null, ctx);
		case "deleted":
		case "conflict": {
			// D18: not ours to start. A composer claim was released in the same transaction.
			const n = r.outcome === "deleted" ? "kept-in-new-deleted" : "kept-in-new-started";
			const external = sending.token === null;
			return fork(
				{ ...e, thread: r.outcome === "deleted" ? "deleted" : e.thread },
				sendingWords(e, sending),
				external ? null : r.revision,
				n);
		}
		case "not-claimed":
			return readNotClaimed(e, sending, r.row, r.thread, ctx);
		case "claimed":
			if (sending.token === null) return failExternal(e, sending, "claimed", false, ctx);
			return claimedElsewhere({ ...forget(e, sending.token), sending: null }, r.row, r.thread, ctx);
		default:
			// A refusal, `draft-conflict` or `unavailable`: D11 (composer) or D10f (external).
			if (sending.token === null) return failExternal(e, sending, r.outcome, false, ctx);
			return releaseNow(e, sending, r.outcome, false, null);
	}
}

/** D11 / D10f / D32: the start was rejected or timed out; it may still commit, so it is fenced. */
function startFailed(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "START_FAILED" }>,
	ctx: SendContext,
): SendEntryTransition {
	const sending = entry.sending;
	if (sending === null || sending.attempt !== ev.attempt || sending.phase !== "starting")
		return none(entry);
	const error = ev.failure.kind === "timeout" ? "timeout" : "error";
	if (sending.token === null) return failExternal(entry, sending, error, false, ctx);
	return releaseNow(entry, sending, error, false, null);
}

// ── D9c / D9d / D20: the chat route ──────────────────────────────────────────────────────────────

/** The statuses the routes answer before their budget hold, storing nothing (D9d (a)). */
const CERTAIN_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 413, 503]);

/**
 * D9d's arms, with revision 7's certain list (ADR 0003 §9.4 change 2): a typed refusal is read by
 * its flags; an untyped status is certain only when it is one of the routes' own pre-hold refusals.
 * Everything else (Stop, the deadline, a network error, 500, 502, 504 …) is uncertain, because the
 * route may still finish and save the turn in the background.
 */
export function classifyRouteFailure(failure: RouteFailure): RouteFailureArm {
	if (failure.kind !== "status") return "uncertain";
	const refusal = failure.refusal;
	if (refusal !== null) {
		if (!refusal.committed) return "certain";
		return refusal.textCommitted ? "committed" : "different-text";
	}
	return CERTAIN_STATUSES.has(failure.status) ? "certain" : "uncertain";
}

/** The failure code a release records (never model output or the user's text). */
function failureCode(failure: RouteFailure): string {
	if (failure.kind !== "status") return failure.kind;
	return failure.refusal?.refusal ?? `status-${failure.status}`;
}

/** D20: the turn is committed with this text; load it, and poll while it is being answered. */
function committedTurn(entry: DraftEntry, failure: RouteFailure, ctx: SendContext): SendEntryTransition {
	const t = reload(entry, ctx);
	const inProgress = failure.kind === "status" && failure.refusal?.refusal === "turn-in-progress";
	return inProgress
		? { entry: t.entry, effects: [...t.effects, { type: "poll-thread", key: entry.key }, notice(entry.key, "being-answered")] }
		: t;
}

/** D9d (a)'s per-refusal extras: a stale or busy transcript is loaded, and the card says why. */
function refusalExtras(entry: DraftEntry, failure: RouteFailure, ctx: SendContext): SendEntryTransition {
	const code = failure.kind === "status" ? (failure.refusal?.refusal ?? null) : null;
	if (code === "transcript-stale") return loadFirst(entry, ctx);
	if (code === "thread-busy") return prepend([notice(entry.key, "thread-busy")], reload(entry, ctx));
	if (code === "client-outdated") return { entry, effects: [notice(entry.key, "reload-to-continue")] };
	if (code === "thread-deleted") return none({ ...entry, thread: "deleted" }); // D18 after the release
	return none(entry);
}

/** D9d / D10f: the turn's chat request failed before `streaming`. */
function routeFailed(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "ROUTE_FAILED" }>,
	ctx: SendContext,
): SendEntryTransition {
	const sending = entry.sending;
	if (sending === null || sending.turnId !== ev.turnId || sending.phase !== "routing")
		return none(entry);
	const removed: SendEffect = { type: "remove-optimistic", key: entry.key, turnId: sending.turnId };
	const arm = classifyRouteFailure(ev.failure);
	const error = failureCode(ev.failure);
	if (sending.token === null) {
		// D10f, for D10y: the same four arms, with (d) read as (b) (a fresh id cannot be stored).
		if (arm === "committed") return prepend([removed], committedTurn({ ...entry, sending: null }, ev.failure, ctx));
		if (error === "thread-deleted")
			return prepend([removed], fork({ ...entry, thread: "deleted" }, sendingWords(entry, sending), null, "kept-in-new-deleted"));
		const extras = arm === "certain" ? refusalExtras(entry, ev.failure, ctx) : none(entry);
		if (extras.entry === null) return extras;
		const t = failExternal(extras.entry, sending, error, arm !== "certain", ctx);
		return prepend([removed, ...extras.effects], t);
	}
	switch (arm) {
		case "certain": {
			// (a): release as certain; the words come back on the definitive answer (D11r).
			const extras = refusalExtras(entry, ev.failure, ctx);
			if (extras.entry === null) return extras;
			return prepend([removed, ...extras.effects], releaseNow(extras.entry, sending, error, false, null));
		}
		case "uncertain":
			// (b): the route may still store the turn, so the release says so (D31's card, R4).
			return prepend([removed], releaseNow(entry, sending, error, true, null));
		case "committed": {
			// (c): not a failure. Consume, then D20.
			const consuming: DraftEntry = { ...entry, sending: { ...sending, phase: "consuming" } };
			const t = committedTurn(consuming, ev.failure, ctx);
			return prepend([removed, consumeEffect(entry.key, sending.token, 0)], t);
		}
		case "different-text": {
			// (d): an earlier text is stored under this id, so the box's text is a new turn: release
			// it under a fresh id (never consumed), and load the stored one (ADR 0003 §9.4 change 1).
			const t = releaseNow(entry, sending, error, false, ctx.fresh.turnId);
			if (t.entry === null) return t;
			const loaded = reload(t.entry, ctx);
			return {
				entry: loaded.entry,
				effects: [removed, ...t.effects, ...loaded.effects, notice(entry.key, "earlier-version-sent")],
			};
		}
	}
}

/** D9c: the hand-off. An external send is done; a claimed one is consumed. */
function routeHandoff(entry: DraftEntry, turnId: string): SendEntryTransition {
	const sending = entry.sending;
	if (sending === null || sending.turnId !== turnId || sending.phase !== "routing") return none(entry);
	if (sending.token === null) return none({ ...entry, sending: null });
	return {
		entry: { ...entry, sending: { ...sending, phase: "consuming" } },
		effects: [consumeEffect(entry.key, sending.token, 0)],
	};
}

/** The answer to `consumeDraft` (D9c, D35). */
function consumeResult(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "CONSUME_RESULT" }>,
	ctx: SendContext,
): SendEntryTransition {
	const sending = entry.sending;
	if (sending === null || sending.token !== ev.token || sending.phase !== "consuming")
		return none(entry);
	const e = acked(entry, ev.seq);
	const r = ev.result;
	switch (r.outcome) {
		case "consumed":
			return consumedArm(e, sending, null, r.revision, ctx);
		case "not-claimed": {
			const t = withThread(e, r.thread.status, ctx);
			if (t.entry === null) return t;
			if (sentProven(r.row, r.thread, sending.turnId))
				return prepend(t.effects, consumedArm(t.entry, sending, r.row, r.row.revision, ctx));
			// The lease released the text although the route has it: a copy came back. Nothing is sent.
			const next = withEpoch(e, {
				...forget(t.entry, ev.token),
				sending: null,
				server: r.row,
				conflict: { kind: "uncertain", row: r.row },
			});
			return { entry: next, effects: t.effects };
		}
		case "gone": {
			// D35 after the hand-off: the text is the sent turn. D19, unless words were typed meanwhile.
			const done: DraftEntry = { ...forget(e, ev.token), sending: null, thread: r.thread.status };
			if (done.local !== null) return fork(done, done.local, null, "kept-in-new-deleted");
			const removed = !ctx.active;
			return {
				entry: removed ? null : { ...done, server: null, epoch: done.epoch + 1 },
				effects: r.thread.status === "deleted" ? [notice(entry.key, "deleted-unsent-removed")] : [],
			};
		}
		default:
			// A refusal: the claim is still ours and heartbeats keep it; retry with D27's backoff (D32).
			return { entry: e, effects: [consumeEffect(entry.key, ev.token, ev.retry + 1)] };
	}
}

// ── The release's answer (D11r, D11c, D11n, D11t, D33, D35) ──────────────────────────────────────

/** D33: the answer to the release of one of this tab's own abandoned claims, with no send live. */
function abandonedReleased(
	entry: DraftEntry,
	token: string,
	result: ReleaseClaimResult,
	ctx: SendContext,
): SendEntryTransition {
	if (result.outcome === "released") {
		const freed = forget(entry, token);
		if (freed.claiming !== null || freed.sending !== null) return none(freed);
		// The released row holds exactly the words this tab claimed, so rebasing on it is safe.
		const row = result.row;
		const local = freed.local !== null && contentEquals(freed.local, row.content) ? null : freed.local;
		return saveIfDirty(none(withEpoch(freed, { ...freed, server: row, local })), ctx);
	}
	if (result.outcome === "not-claimed" || result.outcome === "consumed" || result.outcome === "gone")
		return none(forget(entry, token));
	return { entry, effects: [releaseEffect(entry.key, token, "abandoned", false, null, 1)] };
}

/** The answer to `releaseClaim`. */
function releaseResult(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "RELEASE_RESULT" }>,
	ctx: SendContext,
): SendEntryTransition {
	const sending = entry.sending;
	if (sending === null || sending.token !== ev.token || sending.phase !== "releasing") {
		if (!entry.abandoned.includes(ev.token)) return none(entry);
		const t = abandonedReleased(acked(entry, ev.seq), ev.token, ev.result, ctx);
		// A retry keeps D11t's backoff.
		return {
			...t,
			effects: t.effects.map((x) =>
				x.type === "release" && x.token === ev.token ? releaseEffect(entry.key, ev.token, x.error, x.uncertain, x.freshTurnId, ev.retry + 1) : x,
			),
		};
	}
	const e = acked(entry, ev.seq);
	const r = ev.result;
	switch (r.outcome) {
		case "released":
			return releasedBack(e, sending, r.row, ctx); // D11r
		case "consumed":
			// S4 redirected to S3: the later turn is already in the transcript.
			return sending.kind === "first"
				? committedFirst(e, sending, null, ctx)
				: consumedArm(e, sending, null, r.revision, ctx);
		case "not-claimed":
			return readNotClaimed(e, sending, r.row, r.thread, ctx); // D11c / D11n
		case "gone":
			// D35 before the hand-off: the frozen row was purged; the words move to a new conversation.
			return fork({ ...forget(e, ev.token), thread: r.thread.status }, sendingWords(e, sending), null, "kept-in-new-deleted");
		default:
			return releaseRetry(e, sending, ev.retry);
	}
}

/** D11t: the release keeps failing; retry with backoff. The words are safe in the frozen row. */
function releaseRetry(entry: DraftEntry, sending: DraftSending, retry: number): SendEntryTransition {
	if (sending.token === null) return none(entry);
	const abandoned = entry.abandoned.includes(sending.token)
		? entry.abandoned
		: [...entry.abandoned, sending.token];
	return {
		entry: { ...entry, abandoned },
		effects: [releaseEffect(entry.key, sending.token, "retry", false, null, retry + 1)],
	};
}

// ── D34: the heartbeat's answer ──────────────────────────────────────────────────────────────────

/**
 * D34. `touched` changes nothing. `not-claimed` and `gone` are read only when the send is still
 * `routing` under the token the heartbeat carried: then no write of this claim is outstanding, so
 * `not-claimed` can only mean the lease settled it. In any other phase the in-flight start, consume
 * or release decides, and a heartbeat that raced it is dropped (B1').
 */
function heartbeatResult(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "HEARTBEAT_RESULT" }>,
	ctx: SendContext,
): SendEntryTransition {
	const sending = entry.sending;
	if (sending === null || sending.token !== ev.token || sending.phase !== "routing")
		return none(entry);
	const r = ev.result;
	if (r.outcome === "not-claimed") return readNotClaimed(entry, sending, r.row, r.thread, ctx);
	if (r.outcome === "gone")
		// D35 before the hand-off.
		return fork({ ...entry, thread: r.thread.status }, sendingWords(entry, sending), null, "kept-in-new-deleted");
	return none(entry);
}

// ── D21: discard ─────────────────────────────────────────────────────────────────────────────────

/** D21: Discard. Never while a claim or a send is live, or the row is frozen by another tab. */
function discard(entry: DraftEntry): SendEntryTransition {
	if (entry.claiming !== null || entry.sending !== null || entry.inflight !== null) return none(entry);
	if (entry.server === null || entry.server.state === "sending") return none(entry);
	return { entry, effects: [{ type: "discard", key: entry.key, base: entry.server.revision }] };
}

/** D21: the answer to `discardDraft`. */
function discardResult(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "DISCARD_RESULT" }>,
	ctx: SendContext,
): SendEntryTransition {
	if (entry.server === null || entry.server.revision !== ev.base) return none(entry);
	const e = acked(entry, ev.seq);
	const r = ev.result;
	switch (r.outcome) {
		case "discarded": {
			const shown = shownContent(e);
			const next = withEpoch(e, { ...e, server: null, local: null, conflict: null, pendingFailedSend: null });
			return {
				entry: next,
				effects: [{ type: "offer-undo-discard", key: entry.key, revision: r.revision, content: shown }],
			};
		}
		case "conflict":
			// The discard did not happen: another tab changed the row. Show both texts (D15), unless a
			// claim pressed meanwhile is pending: its own answer decides, and the box stays read-only.
			if (e.claiming !== null || e.sending !== null)
				return { entry: e, effects: [notice(entry.key, "discard-conflict")] };
			return {
				entry: { ...e, local: e.local ?? e.server?.content ?? EMPTY_CONTENT, conflict: { kind: "edited", row: r.row } },
				effects: [notice(entry.key, "discard-conflict")],
			};
		case "claimed":
			return claimedElsewhere(e, r.row, r.thread, ctx);
		case "gone":
			return {
				entry: ctx.active ? withEpoch(e, { ...e, server: null, local: null, thread: r.thread.status }) : null,
				effects: [],
			};
		default:
			return { entry: e, effects: [notice(entry.key, "discard-failed")] };
	}
}

/** D21's Undo: `restoreDraft` of the discarded row; the box shows it again at once. */
function undoDiscard(
	entry: DraftEntry,
	ev: Extract<DraftSendEvent, { type: "UNDO_DISCARD" }>,
	ctx: SendContext,
): SendEntryTransition {
	if (entry.server !== null || entry.inflight !== null || entry.claiming !== null || entry.sending !== null)
		return none(entry);
	const server = rowOf(entry, ctx, {
		revision: ev.revision,
		state: "discarded",
		content: ev.content,
		discardedAt: ctx.now,
	});
	const next = withEpoch(entry, {
		...entry,
		server,
		inflight: { op: "restore", base: ev.revision, content: ev.content, failedSend: null },
	});
	return { entry: next, effects: [{ type: "restore", key: entry.key, base: ev.revision }] };
}

// ── D31 / D9c bars ───────────────────────────────────────────────────────────────────────────────

/** Saves `content` with `dismissFailedSend` (D31's Dismiss; both D9c answers), closing the bar. */
function dismissWith(entry: DraftEntry, local: DraftContent | null): SendEntryTransition {
	const server = entry.server === null ? null : { ...entry.server, failedSend: null };
	const next = withEpoch(entry, { ...entry, local, server, conflict: null });
	if (next.inflight !== null || next.server === null) return none(next);
	const content = local ?? next.server.content;
	return {
		entry: { ...next, save: "saving", inflight: { op: "save", base: next.server.revision, content, failedSend: null } },
		effects: [{ type: "dismiss-failed-send", key: entry.key, base: next.server.revision, content }],
	};
}

// ── D22 / D26 / D30: listed rows ─────────────────────────────────────────────────────────────────

/**
 * D22: this key's row in a `listDrafts` answer requested at `seq`. A key whose last write was
 * answered after `seq` keeps its newer state. A row frozen under another token is D30, under one of
 * this tab's abandoned tokens D33. A row read against a live send of this tab goes through the
 * claim-outcome table (R9), and only while that send is `routing`: in any other phase a write of
 * this claim is in flight and its own answer decides, as for the heartbeat (D34).
 */
function listed(
	entry: DraftEntry,
	seq: number,
	item: DraftListEntry,
	ctx: SendContext,
): SendEntryTransition {
	if (entry.ackSeq >= seq) return none(entry);
	const { row, thread } = item;
	const t = withThread(entry, thread.status, ctx);
	const e = t.entry;
	if (e === null || e.claiming !== null) return t;
	const sending = e.sending;
	if (sending !== null) {
		if (sending.token === null || sending.phase !== "routing") return t;
		if (row.state === "sending" && row.claim?.token === sending.token) return t;
		return prepend(t.effects, readNotClaimed(e, sending, row, thread, ctx));
	}
	if (row.state === "sending" && row.claim !== null)
		return prepend(t.effects, claimedElsewhere(e, row, thread, ctx)); // D30 / D33
	if (e.conflict?.kind === "claimed") {
		// D30 ends: the row is editable again.
		const former = e.conflict.row?.claim?.turnId ?? null;
		const frozen = e.conflict.row?.content ?? null;
		const open: DraftEntry = { ...e, conflict: null };
		if (former !== null && row.lastSent?.turnId === former) {
			if (e.local === null || (frozen !== null && contentEquals(e.local, frozen))) {
				const adopted = withEpoch(e, { ...open, server: row, local: null });
				const loaded = reload(adopted, ctx);
				return {
					entry: loaded.entry,
					effects: [...t.effects, ...loaded.effects, notice(entry.key, "sent-elsewhere")],
				};
			}
			return { entry: { ...open, conflict: { kind: "edited", row } }, effects: t.effects }; // D15
		}
		return prepend(t.effects, adoptOrConflict(open, row, ctx));
	}
	return prepend(t.effects, adoptOrConflict(e, row, ctx));
}

/** D22's last arms, and D31: adopt a row when nothing is unsaved; otherwise a newer row is D15/D16. */
function adoptOrConflict(entry: DraftEntry, row: ServerDraft, ctx: SendContext): SendEntryTransition {
	let next: DraftEntry = entry;
	if (entry.local === null) {
		// A discarded row is not a draft the box shows.
		next = withEpoch(entry, { ...entry, server: row.state === "discarded" ? null : row });
	} else if (entry.conflict === null && row.revision > (entry.server?.revision ?? 0)) {
		next = { ...entry, conflict: { kind: row.state === "discarded" ? "discarded" : "edited", row } };
	}
	if (row.failedSend?.uncertain === true && next.conflict === null)
		next = { ...next, conflict: { kind: "uncertain", row: null } }; // D31
	return saveIfDirty(none(next), ctx);
}

/**
 * D26: a cache item restored at `LOAD`, read against the scope's listed row (`item`, or null when
 * the list does not hold the key). A restored claim or send is released at once by its own token and
 * read by D11r / D11c / D11n; a restored external send is D10f with `error: "reload"`. Unsaved words
 * on a row that moved since their base are a conflict (D15), never a resurrection (AC10); on a row
 * that is gone they move to a new conversation (D18), never back into a deleted one (AC16).
 */
export function restoreFromCache(
	cached: CachedDraft,
	item: DraftListEntry | null,
	ctx: SendContext,
): SendEntryTransition {
	const status = item?.thread.status ?? "none";
	const base: DraftEntry = {
		key: cached.key,
		server: item?.row ?? null,
		local: cached.local,
		epoch: cached.epoch,
		claiming: null,
		sending: null,
		pendingFailedSend: null,
		abandoned: cached.abandoned,
		save: "idle",
		blockedBy: null,
		conflict: null,
		thread: status,
		transcript: status === "listed" || status === "unlisted" ? "unloaded" : "loaded",
		ackSeq: 0,
		inflight: null,
		credentialAck: false,
		transientFailures: 0,
		errorFailures: 0,
	};
	const claim = cached.claiming;
	if (claim !== null) {
		const sending: DraftSending = {
			...claim,
			text: claim.content.text,
			mentions: claim.content.mentions,
			cellTarget: claim.content.cellTarget,
			origin: "composer",
			at: Date.parse(ctx.now),
			phase: "releasing",
		};
		return {
			entry: { ...base, sending },
			effects: [releaseEffect(cached.key, claim.token, "reload", false, null, 0)],
		};
	}
	const s = cached.sending;
	if (s !== null) {
		if (s.token === null) return failExternal(base, s, "reload", s.kind === "later", ctx);
		const uncertain = s.kind === "later" && s.phase !== "starting";
		return {
			entry: { ...base, sending: { ...s, phase: "releasing" } },
			effects: [releaseEffect(cached.key, s.token, "reload", uncertain, null, 0)],
		};
	}
	if (cached.local === null) return none(base);
	if (item === null) {
		if (cached.base === 0) return saveNow(base, ctx);
		return fork(base, cached.local, null, "kept-in-new-deleted");
	}
	if (item.row.revision > cached.base) {
		const kind = item.row.state === "discarded" ? "discarded" : "edited";
		return none({ ...base, server: null, conflict: { kind, row: item.row } });
	}
	return saveNow(base, ctx);
}

// ── Reading drafting answers the sending half owns (D18, D30, D33, D10f's fence) ─────────────────

/**
 * The answers to a SAVE that the sending half reads, or null to leave the event to the drafting
 * half: `claimed` (D30 / D33), `gone` while the box holds words (D18), and D10f's fencing save
 * answered `conflict` by the start it fenced (D17: the prompt is taken back out of the box).
 */
export function interceptDraftingEvent(
	entry: DraftEntry,
	event: DraftEntryEvent,
	ctx: SendContext,
): SendEntryTransition | null {
	if (event.type !== "SAVE_RESULT") return null;
	const inflight = entry.inflight;
	if (inflight === null || inflight.op !== "save") return null;
	const settled: DraftEntry = {
		...acked(entry, event.seq),
		inflight: null,
		save: entry.save === "saving" ? "idle" : entry.save,
	};
	const r = event.result;
	if (r.outcome === "claimed") {
		const freed = entry.claiming === null ? settled : unclaim(settled, entry.claiming);
		const n = entry.claiming === null ? [] : [notice(entry.key, "not-sent")];
		return prepend(n, claimedElsewhere(freed, r.row, r.thread, ctx));
	}
	if (r.outcome === "gone" && entry.sending === null) {
		const words = entry.claiming?.content ?? entry.local;
		if (words === null) return null; // D19, the drafting half's
		const freed: DraftEntry = { ...settled, claiming: null, thread: r.thread.status };
		return fork(freed, words, null, "kept-in-new-deleted");
	}
	const fence = ctx.fence;
	if (r.outcome === "conflict" && fence !== null && r.thread.firstTurnId === fence.turnId) {
		// D10f → D17: D10x's start committed first. The prompt leaves the box; the box keeps what it
		// held before, unless the user typed since (I5: then the words stay, beside the row, as D15).
		const typed = entry.local !== null && !contentEquals(entry.local, fence.merged);
		const before = contentEquals(fence.before, r.row.content) ? null : fence.before;
		const next = withEpoch(entry, {
			...settled,
			server: r.row,
			local: typed ? entry.local : before,
			pendingFailedSend: null,
			thread: "listed",
			conflict: typed ? { kind: "edited", row: r.row } : entry.conflict,
		});
		const t = reload(next, ctx);
		return { entry: t.entry, effects: [...t.effects, notice(entry.key, "first-sent")], fence: null };
	}
	return null;
}

/**
 * After the drafting half answered a save: a claim that waited behind it (D9, submitted while that
 * save flew) now goes, at the base the answer left; and a fence whose marker was acknowledged ends.
 */
export function afterDrafting(
	before: DraftEntry,
	t: SendEntryTransition,
): SendEntryTransition {
	const after = t.entry;
	if (after === null) return t;
	let out = t;
	if (
		before.claiming !== null &&
		before.inflight !== null &&
		after.inflight === null &&
		after.claiming !== null
	)
		out = { ...out, effects: [...out.effects, claimEffect(after, after.claiming)] };
	if (after.pendingFailedSend === null && out.fence === undefined) out = { ...out, fence: null };
	return out;
}

// ── The sending entry reducer ────────────────────────────────────────────────────────────────────

/** True for the events of the sending half (the rest are the drafting half's). */
export function isSendEvent(event: DraftEntryEvent | DraftSendEvent): event is DraftSendEvent {
	switch (event.type) {
		case "EDIT":
		case "SAVE_TRIGGER":
		case "SAVE_RESULT":
		case "RESTORE_RESULT":
		case "WRITE_REJECTED":
		case "CONFLICT_KEEP_MINE":
		case "CONFLICT_USE_THEIRS":
		case "CONFLICT_RESTORE":
		case "CONFLICT_LET_GO":
		case "NOT_LISTED":
		case "CREDENTIAL_ACK":
		case "UNBLOCK":
		case "TRANSCRIPT_LOADED":
			return false;
		default:
			return true;
	}
}

/** The per-key reduction of the sending half. It touches only the entry it is given. */
export function reduceSendEntry(
	entry: DraftEntry,
	event: DraftSendEvent,
	ctx: SendContext,
): SendEntryTransition {
	switch (event.type) {
		case "SUBMIT":
			return submit(entry, event.chatReady, ctx);
		case "SUBMIT_EXTERNAL":
			return submitExternal(entry, event, ctx);
		case "CLAIM_RESULT":
			return claimResult(entry, event, ctx);
		case "CLAIM_FAILED":
			return claimFailed(entry, event, ctx);
		case "START_RESULT":
			return startResult(entry, event, ctx);
		case "START_FAILED":
			return startFailed(entry, event, ctx);
		case "ROUTE_HANDOFF":
			return routeHandoff(entry, event.turnId);
		case "ROUTE_FAILED":
			return routeFailed(entry, event, ctx);
		case "CONSUME_RESULT":
			return consumeResult(entry, event, ctx);
		case "CONSUME_FAILED": {
			const sending = entry.sending;
			if (sending === null || sending.token !== event.token || sending.phase !== "consuming")
				return none(entry);
			return { entry, effects: [consumeEffect(entry.key, event.token, event.retry + 1)] }; // D32
		}
		case "RELEASE_RESULT":
			return releaseResult(entry, event, ctx);
		case "RELEASE_FAILED": {
			const sending = entry.sending;
			if (sending !== null && sending.token === event.token && sending.phase === "releasing")
				return releaseRetry(entry, sending, event.retry); // D11t
			if (!entry.abandoned.includes(event.token)) return none(entry);
			return { entry, effects: [releaseEffect(entry.key, event.token, "abandoned", false, null, event.retry + 1)] };
		}
		case "HEARTBEAT_RESULT":
			return heartbeatResult(entry, event, ctx);
		case "DISCARD":
			return discard(entry);
		case "DISCARD_RESULT":
			return discardResult(entry, event, ctx);
		case "DISCARD_FAILED":
			return { entry, effects: [notice(entry.key, "discard-failed")] };
		case "UNDO_DISCARD":
			return undoDiscard(entry, event, ctx);
		case "UNCERTAIN_DISMISS":
			if (entry.conflict?.kind !== "uncertain" || entry.conflict.row !== null) return none(entry);
			return dismissWith(entry, entry.local);
		case "COPY_KEEP": {
			const row = entry.conflict?.kind === "uncertain" ? entry.conflict.row : null;
			if (row === null) return none(entry);
			return dismissWith(entry, entry.local === null ? null : appendContent(row.content, entry.local));
		}
		case "COPY_DISCARD": {
			const row = entry.conflict?.kind === "uncertain" ? entry.conflict.row : null;
			if (row === null) return none(entry);
			return dismissWith(entry, entry.local ?? EMPTY_CONTENT);
		}
		case "LISTED":
			return listed(entry, event.seq, event.listed, ctx);
	}
}
