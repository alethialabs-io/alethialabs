// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drafting half of the Elench drafts reducer (ADR 0001 §7.2): D1-D8, D14-D16, D19, D19L,
// D23-D25, D27-D29 and D36. Pure: no I/O, no React, no store, no clock and no random ids. Every id
// and timestamp it needs arrives in the event or the environment, and everything it wants done
// comes back as an effect.
//
// Two levels. `reduceDraftEntry(entry, event, ctx)` is the per-key reduction, and touches only the
// entry it is given. `reduceDrafts(state, event, env)` is the store around it: the active key per
// scope, the scope, the page org and the viewer (D1-D4, D23, D25, D29), and it routes a key's own
// events to `reduceDraftEntry` for that key alone.
//
// None of these transitions reads a claim outcome. The send transitions (D9-D13, D17, D18, D20-D22,
// D26, D30-D35) will be slice 7b's, in reducer-sending.ts. Until then, a save answer that one of
// them reads (`claimed`, which is D30; `gone` while the box holds unsaved words, which is D18)
// settles the request here and keeps every word where it was, so nothing is lost meanwhile.
//
// No caller yet: the effects layer (queue, cache, page org, list) will be slice 8's.

import {
	type DraftContent,
	type DraftEditorContent,
	type DraftMention,
	normalizeDraftText,
} from "@/lib/elench/draft-content";
import type { DraftThreadStatus, ServerDraft } from "@/lib/elench/draft-outcomes";
import type {
	DraftBlockReason,
	DraftEffect,
	DraftEntry,
	DraftEntryContext,
	DraftEntryEvent,
	DraftEntryTransition,
	DraftKey,
	DraftNotice,
	DraftSaveState,
	DraftScope,
	DraftsEvent,
	DraftsState,
	DraftsTransition,
	PendingFailedSend,
} from "@/lib/stores/elench-drafts/types";

/** The autosave debounce: a save runs after this much quiet (D5). */
export const SAVE_DEBOUNCE_MS = 800;

/** The longest wait between two retries of a transient failure (D27). */
export const MAX_RETRY_DELAY_MS = 60_000;

/** How many times a rejected call that is not a network failure is retried before it blocks (D27). */
export const MAX_ERROR_RETRIES = 3;

/** The content of an empty box. */
export const EMPTY_CONTENT: DraftContent = {
	text: "",
	mentions: [],
	artifacts: [],
	cellTarget: null,
};

/** The facts the store reduction needs from the tab: its id and the time, both supplied by the caller. */
export interface DraftsEnv {
	tabId: string;
	now: string;
}

// ── Keys and content ─────────────────────────────────────────────────────────────────────────────

/** The string id of a scope: its org id and its anchor (`org` or `project:<id>`). */
export function scopeId(scope: DraftScope): string {
	return `${scope.orgId}:${scope.projectId === null ? "org" : `project:${scope.projectId}`}`;
}

/** The string id of a key: its scope id and its conversation id. */
export function keyId(key: DraftKey): string {
	return `${scopeId(key)}:${key.conversationId}`;
}

/** True when two scopes are the same org and the same anchor. */
function sameScope(a: DraftScope, b: DraftScope): boolean {
	return a.orgId === b.orgId && a.projectId === b.projectId;
}

/** True when two mention spans are the same pill at the same place. */
function mentionEquals(a: DraftMention, b: DraftMention): boolean {
	return (
		a.id === b.id &&
		a.type === b.type &&
		a.label === b.label &&
		a.start === b.start &&
		a.end === b.end
	);
}

/** True when two contents are the same text, pills, artifacts and cell target. */
export function contentEquals(a: DraftContent, b: DraftContent): boolean {
	return (
		a.text === b.text &&
		a.mentions.length === b.mentions.length &&
		a.mentions.every((m, i) => mentionEquals(m, b.mentions[i])) &&
		a.artifacts.length === b.artifacts.length &&
		a.artifacts.every((x, i) => x === b.artifacts[i]) &&
		(a.cellTarget === null
			? b.cellTarget === null
			: b.cellTarget !== null &&
				a.cellTarget.x === b.cellTarget.x &&
				a.cellTarget.y === b.cellTarget.y)
	);
}

/** True when a content holds nothing at all: no text, no pill, no artifact and no cell target. */
export function isEmptyContent(c: DraftContent): boolean {
	return (
		c.text === "" && c.mentions.length === 0 && c.artifacts.length === 0 && c.cellTarget === null
	);
}

/**
 * Normalizes what the editor yields (§4.1): the text and every pill's id and label lose U+0000 and
 * lone surrogates. The editor normalizes before it takes a span, so this changes nothing for a
 * well-behaved editor; when it does change the text, a span that no longer sits on its `@label` is
 * dropped rather than left pointing at the wrong characters (its text stays in the box).
 */
export function normalizeEditorContent(content: DraftEditorContent): DraftEditorContent {
	const text = normalizeDraftText(content.text);
	const mentions: DraftMention[] = [];
	let previousEnd = 0;
	for (const span of content.mentions) {
		const label = normalizeDraftText(span.label);
		const id = normalizeDraftText(span.id);
		if (label === "") continue;
		if (span.start < previousEnd || span.end > text.length) continue;
		if (text.slice(span.start, span.end) !== `@${label}`) continue;
		mentions.push({ ...span, id, label });
		previousEnd = span.end;
	}
	return { text, mentions };
}

/**
 * What the box shows (§7.1): the claimed content while a claim is pending (read-only); only the
 * text typed after the claim while a claimed send is live; otherwise `local ?? server.content`.
 */
export function shownContent(entry: DraftEntry): DraftContent {
	if (entry.claiming !== null) return entry.claiming.content;
	if (entry.sending !== null && entry.sending.token !== null) return entry.local ?? EMPTY_CONTENT;
	return entry.local ?? entry.server?.content ?? EMPTY_CONTENT;
}

/** A fresh entry for a key this tab has no row for yet. */
export function newEntry(key: DraftKey, thread: DraftThreadStatus): DraftEntry {
	return {
		key,
		server: null,
		local: null,
		epoch: 0,
		claiming: null,
		sending: null,
		pendingFailedSend: null,
		abandoned: [],
		save: "idle",
		blockedBy: null,
		conflict: null,
		thread,
		transcript: thread === "listed" || thread === "unlisted" ? "unloaded" : "loaded",
		ackSeq: 0,
		inflight: null,
		credentialAck: false,
		transientFailures: 0,
		errorFailures: 0,
	};
}

// ── The credential detector (Q7, D36) ────────────────────────────────────────────────────────────

/**
 * Shapes of well-known credentials. Best-effort and client-side by decision (Q7): a match holds the
 * autosave until the user answers; a miss changes nothing, and the notice claims no more than that.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{36,}/,
	/\bgithub_pat_[A-Za-z0-9_]{22,}/,
	/\bglpat-[A-Za-z0-9_-]{20,}/,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/,
	/\b[sr]k_live_[A-Za-z0-9]{16,}/,
	/\bsk-[A-Za-z0-9_-]{20,}/,
	/\bAIza[0-9A-Za-z_-]{35}/,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/\b(?:client-key-data|client-certificate-data|token)\s*:\s*\S{16,}/,
	/\b(?:password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** True when `text` contains something shaped like a credential (best-effort, Q7). */
export function looksLikeCredential(text: string): boolean {
	return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when this key's unsaved words must not reach the server until the user answers D36. */
function credentialHolds(entry: DraftEntry): boolean {
	return entry.local !== null && !entry.credentialAck && looksLikeCredential(entry.local.text);
}

// ── Save state helpers ───────────────────────────────────────────────────────────────────────────

/** True for the states the footer reports as "not saved to your account" (§7.4). */
function isUnsaved(save: DraftSaveState): boolean {
	return save === "retrying" || save === "held" || save === "blocked";
}

/** The notice raised when a key enters `save` for `reason` (G19: once per entry, naming the key). */
function noticeFor(save: DraftSaveState, reason: DraftBlockReason | null): DraftNotice {
	if (reason?.kind === "credential") return "credential";
	if (reason?.kind === "other-org") return "held-other-org";
	return save === "retrying" ? "unsaved" : "blocked";
}

/**
 * Moves a key into an unsaved state, and raises a notice only when it ENTERS it (G19): staying in
 * the same state for the same reason raises nothing, and leaving and entering again raises again.
 */
function enterUnsaved(
	entry: DraftEntry,
	save: DraftSaveState,
	reason: DraftBlockReason | null,
): DraftEntryTransition {
	const same = entry.save === save && entry.blockedBy?.kind === reason?.kind;
	const next: DraftEntry = { ...entry, save, blockedBy: reason };
	return {
		entry: next,
		effects: same ? [] : [{ type: "notice", key: entry.key, notice: noticeFor(save, reason) }],
	};
}

/** The backoff before retry number `n` of a transient failure: 1, 2, 4 … 60 s (D27). */
export function retryDelayMs(n: number): number {
	return Math.min(1000 * 2 ** Math.max(0, n - 1), MAX_RETRY_DELAY_MS);
}

/** Appends effects to a transition. */
function withEffects(t: DraftEntryTransition, effects: DraftEffect[]): DraftEntryTransition {
	return { entry: t.entry, effects: [...t.effects, ...effects] };
}

/** No change. */
function unchanged(entry: DraftEntry): DraftEntryTransition {
	return { entry, effects: [] };
}

// ── D7: send a save ──────────────────────────────────────────────────────────────────────────────

/**
 * D7: sends `saveDraft(base = server?.revision ?? 0, local)` when the key is dirty and nothing
 * forbids it: no request in flight, no claim and no send (a frozen row is never saved), no open
 * conflict (D15/D16), not blocked (D28), no credential hold (D36), and the page shows the key's
 * org (D29; otherwise the key is held, and nothing is POSTed).
 */
function trySave(entry: DraftEntry, ctx: DraftEntryContext): DraftEntryTransition {
	if (entry.local === null) return unchanged(entry);
	if (entry.inflight !== null) return unchanged(entry);
	if (entry.claiming !== null || entry.sending !== null) return unchanged(entry);
	if (entry.conflict !== null) return unchanged(entry);
	if (entry.save === "blocked") return unchanged(entry);
	if (credentialHolds(entry)) return enterUnsaved(entry, "held", { kind: "credential" });
	if (ctx.pageOrg !== entry.key.orgId) return enterUnsaved(entry, "held", { kind: "other-org" });
	const base = entry.server?.revision ?? 0;
	const failedSend: PendingFailedSend | null = entry.pendingFailedSend;
	return {
		entry: {
			...entry,
			save: "saving",
			blockedBy: null,
			inflight: { op: "save", base, content: entry.local, failedSend },
		},
		effects: [{ type: "save", key: entry.key, base, content: entry.local, failedSend }],
	};
}

// ── D5 / D6 / D36: an edit ───────────────────────────────────────────────────────────────────────

/**
 * D5: an edit stamped with the current epoch becomes `local` (normalized; the shown content's
 * artifacts and cell target carried over), and schedules a save. D6: an older epoch is dropped.
 * The box is read-only while a claim is pending. D36: an edit whose text newly looks like a
 * credential holds the autosave; editing the match away lifts the hold.
 */
function reduceEdit(
	entry: DraftEntry,
	epoch: number,
	content: DraftEditorContent,
): DraftEntryTransition {
	if (epoch !== entry.epoch) return unchanged(entry); // D6 (I6)
	if (entry.claiming !== null) return unchanged(entry); // read-only for one round trip (D9/D10)
	const edited = normalizeEditorContent(content);
	const shown = shownContent(entry);
	const next: DraftContent = {
		text: edited.text,
		mentions: edited.mentions,
		artifacts: shown.artifacts,
		cellTarget: shown.cellTarget,
	};
	let local: DraftContent | null = next;
	if (entry.sending !== null && entry.sending.token !== null) {
		// The box holds only what is typed after the claim; nothing typed is nothing to keep.
		if (isEmptyContent(next)) local = null;
	} else if (entry.sending === null) {
		// Equal to the acknowledged row is not enough while a save flies: its ack will make the row
		// the in-flight content, so the box must keep these words as unsaved and save them after (I5).
		const flying = entry.inflight !== null && !contentEquals(next, entry.inflight.content);
		const matchesRow =
			entry.server !== null ? contentEquals(next, entry.server.content) : isEmptyContent(next);
		// While a conflict bar is open the box is "mine" by definition (D15/D16): never null.
		if (matchesRow && !flying && entry.conflict === null) local = null;
	}
	const edit: DraftEntry = { ...entry, local };
	const held = entry.blockedBy?.kind === "credential";
	if (credentialHolds(edit)) {
		return held ? unchanged(edit) : enterUnsaved(edit, "held", { kind: "credential" });
	}
	const lifted: DraftEntry = held ? { ...edit, save: "idle", blockedBy: null } : edit;
	return {
		entry: lifted,
		effects:
			local === null ? [] : [{ type: "schedule-save", key: entry.key, delayMs: SAVE_DEBOUNCE_MS, reason: "timer" }],
	};
}

// ── D8, D14-D16, D19, D24, D27, D28: a write's answer ────────────────────────────────────────────

/** The row the server now holds after acknowledging `sent` at revision `r` (D8), as `saveDraft` writes it. */
function acknowledgedRow(
	entry: DraftEntry,
	sent: DraftContent,
	revision: number,
	carried: PendingFailedSend | null,
	ctx: DraftEntryContext,
): ServerDraft {
	const prev = entry.server;
	let failedSend = prev?.failedSend ?? null;
	if (carried !== null) failedSend = { ...carried, at: ctx.now };
	else if (failedSend !== null && !failedSend.uncertain && prev?.content.text !== sent.text)
		failedSend = null;
	return {
		orgId: entry.key.orgId,
		projectId: entry.key.projectId,
		conversationId: entry.key.conversationId,
		revision,
		state: "active",
		content: sent,
		claim: null,
		failedSend,
		lastSent: prev?.lastSent ?? null,
		threadSeen: prev?.threadSeen ?? false,
		title: prev?.title ?? null,
		lastWriter: ctx.tabId,
		discardedAt: null,
		updatedAt: ctx.now,
	};
}

/** Settles the in-flight write: records its sequence number and clears the slot. */
function settle(entry: DraftEntry, seq: number): DraftEntry {
	return { ...entry, inflight: null, ackSeq: Math.max(entry.ackSeq, seq) };
}

/** Clears the failure counters and any non-hold save state after an answer that is not a failure. */
function answered(entry: DraftEntry): DraftEntry {
	const keepHold = entry.save === "held" && entry.blockedBy?.kind === "credential";
	return {
		...entry,
		save: keepHold ? "held" : "idle",
		blockedBy: keepHold ? entry.blockedBy : null,
		transientFailures: 0,
		errorFailures: 0,
	};
}

/**
 * Enters `retrying` and schedules retry `n`. A retry that fails again has not left the unsaved state
 * (nothing was acknowledged in between), so it raises no second notice (G19).
 */
function retryAfter(entry: DraftEntry, n: number): DraftEntryTransition {
	const failing = entry.transientFailures + entry.errorFailures > 0;
	const t = enterUnsaved(entry, "retrying", null);
	const effects = failing ? t.effects.filter((x) => x.type !== "notice") : t.effects;
	return {
		entry: t.entry,
		effects: [...effects, { type: "schedule-save", key: entry.key, delayMs: retryDelayMs(n), reason: "retry" }],
	};
}

/** D27: a transient failure. The key retries with backoff and says so once per entry. */
function transientFailure(entry: DraftEntry): DraftEntryTransition {
	const n = entry.transientFailures + 1;
	const t = retryAfter(entry, n);
	return t.entry === null ? t : { ...t, entry: { ...t.entry, transientFailures: n } };
}

/** D27 / D28: a rejected call that is not a network failure is retried three times, then blocks. */
function errorFailure(entry: DraftEntry): DraftEntryTransition {
	const n = entry.errorFailures + 1;
	if (n > MAX_ERROR_RETRIES)
		return enterUnsaved({ ...entry, errorFailures: n }, "blocked", { kind: "error" });
	const t = retryAfter(entry, n);
	return t.entry === null ? t : { ...t, entry: { ...t.entry, errorFailures: n } };
}

/** D19: the row is gone and the box holds nothing unsaved; a non-active key's entry is removed. */
function goneWithNothingUnsaved(
	entry: DraftEntry,
	thread: DraftThreadStatus | null,
	ctx: DraftEntryContext,
): DraftEntryTransition {
	const effects: DraftEffect[] =
		thread === "deleted"
			? [{ type: "notice", key: entry.key, notice: "deleted-unsent-removed" }]
			: [];
	if (!ctx.active) return { entry: null, effects };
	return { entry: { ...entry, server: null, epoch: entry.epoch + 1 }, effects };
}

/**
 * The answers every write shares: the refusals of §4 (D24, D27, D28) and `gone` (D19; while the
 * box holds unsaved words it will be D18, slice 7b's, and until then the words simply stay).
 * Returns null for an answer the caller reads itself.
 */
function reduceSharedOutcome(
	entry: DraftEntry,
	result:
		| { outcome: "gone"; thread: { status: DraftThreadStatus } }
		| { outcome: "limit" }
		| { outcome: "invalid" }
		| { outcome: "unauthorized" }
		| { outcome: "forbidden"; reason?: "membership" }
		| { outcome: "scope-changed"; reason: "other-org" }
		| { outcome: "scope-changed"; reason: "address"; slug: string }
		| { outcome: "rate-limited" }
		| { outcome: "unavailable" },
	ctx: DraftEntryContext,
): DraftEntryTransition {
	switch (result.outcome) {
		case "gone": {
			const next: DraftEntry = { ...answered(entry), thread: result.thread.status };
			if (next.local === null && next.claiming === null && next.sending === null)
				return goneWithNothingUnsaved(next, result.thread.status, ctx);
			return unchanged(next);
		}
		case "limit":
			return enterUnsaved(entry, "blocked", { kind: "limit" });
		case "invalid":
			return enterUnsaved(entry, "blocked", { kind: "invalid" });
		case "unauthorized":
			return enterUnsaved(entry, "blocked", { kind: "unauthorized" });
		case "forbidden":
			return enterUnsaved(entry, "blocked", {
				kind: "forbidden",
				membership: result.reason === "membership",
			});
		case "scope-changed":
			return result.reason === "other-org"
				? enterUnsaved(entry, "held", { kind: "other-org" })
				: enterUnsaved(entry, "blocked", { kind: "address", slug: result.slug });
		case "rate-limited":
		case "unavailable":
			return transientFailure(entry);
	}
}

/**
 * D14 / D14s / D15: a conflict on a save. D14 adopts a row that already holds exactly the unsaved
 * words; D14s rebases silently when the row's last writer is this tab (its own abandoned save
 * landed); otherwise D15 opens the conflict bar and keeps the words.
 */
function reduceConflict(
	entry: DraftEntry,
	row: ServerDraft,
	ctx: DraftEntryContext,
): DraftEntryTransition {
	// Nothing unsaved (the box was edited back to the row it was based on while the save flew):
	// nothing is replaced here, so no keystroke in flight can be dropped (I6). From slice 7b the next
	// list refresh will adopt the newer row (D22); until then an edit saves at the old base and its
	// conflict opens D15, which shows both texts.
	if (entry.local === null) return unchanged(entry);
	if (contentEquals(entry.local, row.content)) return unchanged({ ...entry, server: row, local: null }); // D14
	if (row.lastWriter === ctx.tabId) return trySave({ ...entry, server: row }, ctx); // D14s
	return unchanged({ ...entry, conflict: { kind: "edited", row } }); // D15
}

/** The answer to this key's `saveDraft` (D8, D14-D16, D19, D24, D27, D28). */
function reduceSaveResult(
	entry: DraftEntry,
	event: Extract<DraftEntryEvent, { type: "SAVE_RESULT" }>,
	ctx: DraftEntryContext,
): DraftEntryTransition {
	const inflight = entry.inflight;
	if (inflight === null || inflight.op !== "save") return unchanged(entry);
	const settled = settle(entry, event.seq);
	const result = event.result;
	switch (result.outcome) {
		case "saved": {
			// D8
			const sent = inflight.content;
			const acked: DraftEntry = {
				...answered(settled),
				server: acknowledgedRow(entry, sent, result.revision, inflight.failedSend, ctx),
				pendingFailedSend: inflight.failedSend !== null ? null : settled.pendingFailedSend,
			};
			if (acked.local !== null && contentEquals(acked.local, sent))
				return unchanged({ ...acked, local: null });
			return trySave(acked, ctx);
		}
		case "conflict":
			return reduceConflict(
				{ ...answered(settled), thread: result.thread.status },
				result.row,
				ctx,
			);
		case "discarded": // D16
			return unchanged({
				...answered(settled),
				thread: result.thread.status,
				conflict: { kind: "discarded", row: result.row },
			});
		case "claimed":
			// D30 will read this from slice 7b. Until then the request is settled and the words stay.
			return unchanged({ ...answered(settled), thread: result.thread.status });
		default:
			return reduceSharedOutcome(settled, result, ctx);
	}
}

/** The answer to D16's `restoreDraft`: on `saved` the row is active again and the words save on it. */
function reduceRestoreResult(
	entry: DraftEntry,
	event: Extract<DraftEntryEvent, { type: "RESTORE_RESULT" }>,
	ctx: DraftEntryContext,
): DraftEntryTransition {
	const inflight = entry.inflight;
	if (inflight === null || inflight.op !== "restore") return unchanged(entry);
	const settled = settle(entry, event.seq);
	const result = event.result;
	switch (result.outcome) {
		case "saved": {
			const server: ServerDraft | null =
				settled.server === null
					? null
					: {
							...settled.server,
							state: "active",
							discardedAt: null,
							revision: result.revision,
						};
			return trySave({ ...answered(settled), server }, ctx);
		}
		case "conflict":
			return reduceConflict(
				{ ...answered(settled), thread: result.thread.status },
				result.row,
				ctx,
			);
		default:
			return reduceSharedOutcome(settled, result, ctx);
	}
}

// ── The entry reducer ────────────────────────────────────────────────────────────────────────────

/** True while I4 lets this key keep a `sessionStorage` item: something is unacknowledged. */
function holdsCache(entry: DraftEntry | null): boolean {
	return (
		entry !== null &&
		(entry.local !== null ||
			entry.claiming !== null ||
			entry.sending !== null ||
			entry.pendingFailedSend !== null)
	);
}

/** The per-key reduction, before the cache rule is applied. */
function reduceEntryEvent(
	entry: DraftEntry,
	event: DraftEntryEvent,
	ctx: DraftEntryContext,
): DraftEntryTransition {
	switch (event.type) {
		case "EDIT":
			return reduceEdit(entry, event.epoch, event.content);
		case "SAVE_TRIGGER":
			// D7. While retrying, only the backoff timer, `online` and a submit send: an edit's debounce
			// would otherwise defeat D27's backoff.
			if (
				entry.save === "retrying" &&
				event.reason !== "retry" &&
				event.reason !== "online" &&
				event.reason !== "before-submit"
			)
				return unchanged(entry);
			return trySave(entry, ctx);
		case "SAVE_RESULT":
			return reduceSaveResult(entry, event, ctx);
		case "RESTORE_RESULT":
			return reduceRestoreResult(entry, event, ctx);
		case "WRITE_REJECTED": {
			if (entry.inflight === null) return unchanged(entry);
			const settled = settle(entry, event.seq);
			return event.rejection.network ? transientFailure(settled) : errorFailure(settled);
		}
		case "CONFLICT_KEEP_MINE": {
			// D15 "Keep mine": save the words at the row's revision.
			const row = entry.conflict?.kind === "edited" ? entry.conflict.row : null;
			if (row === null) return unchanged(entry);
			return trySave({ ...entry, server: row, conflict: null }, ctx);
		}
		case "CONFLICT_USE_THEIRS": {
			// D15 "Use theirs": the box is replaced from outside, so the epoch moves (I6).
			const row = entry.conflict?.kind === "edited" ? entry.conflict.row : null;
			if (row === null) return unchanged(entry);
			return unchanged({
				...entry,
				server: row,
				local: null,
				conflict: null,
				epoch: entry.epoch + 1,
			});
		}
		case "CONFLICT_RESTORE": {
			// D16 "Restore": `restoreDraft` at the discarded row's revision, then a save (on its answer).
			const row = entry.conflict?.kind === "discarded" ? entry.conflict.row : null;
			if (row === null || entry.inflight !== null) return unchanged(entry);
			// With nothing unsaved the box now shows the restored row: replaced from outside (D6, I6).
			const replaced = !contentEquals(shownContent(entry), entry.local ?? row.content);
			return {
				entry: {
					...entry,
					epoch: replaced ? entry.epoch + 1 : entry.epoch,
					server: row,
					conflict: null,
					inflight: { op: "restore", base: row.revision, content: row.content, failedSend: null },
				},
				effects: [{ type: "restore", key: entry.key, base: row.revision }],
			};
		}
		case "CONFLICT_LET_GO":
			// D16 "Let it go": the entry is removed.
			if (entry.conflict?.kind !== "discarded") return unchanged(entry);
			return { entry: null, effects: [] };
		case "NOT_LISTED":
			// D19L: never a key with unsaved words, a send, a write in flight, no row ever seen, or a
			// write answered after the list was requested.
			if (
				entry.local !== null ||
				entry.claiming !== null ||
				entry.sending !== null ||
				entry.inflight !== null ||
				entry.server === null ||
				entry.ackSeq >= event.seq
			)
				return unchanged(entry);
			return goneWithNothingUnsaved(entry, null, ctx);
		case "CREDENTIAL_ACK": {
			// D36 "Save to my account": the key records the answer, the hold lifts, and D7 runs.
			const lifted: DraftEntry =
				entry.blockedBy?.kind === "credential"
					? { ...entry, credentialAck: true, save: "idle", blockedBy: null }
					: { ...entry, credentialAck: true };
			return trySave(lifted, ctx);
		}
		case "UNBLOCK": {
			// D28's two automatic retries.
			const want = event.reason === "signed-in" ? "unauthorized" : "limit";
			if (entry.save !== "blocked" || entry.blockedBy?.kind !== want) return unchanged(entry);
			return trySave({ ...entry, save: "idle", blockedBy: null }, ctx);
		}
		case "TRANSCRIPT_LOADED":
			return unchanged({ ...entry, transcript: "loaded" });
	}
}

/**
 * The per-key reduction. It returns the next entry for the SAME key (null when the entry is
 * removed), and its effects. When the entry stops holding anything unacknowledged, it also asks for
 * the key's cache item to be removed (I4).
 */
export function reduceDraftEntry(
	entry: DraftEntry,
	event: DraftEntryEvent,
	ctx: DraftEntryContext,
): DraftEntryTransition {
	const t = reduceEntryEvent(entry, event, ctx);
	if (holdsCache(entry) && !holdsCache(t.entry))
		return withEffects(t, [{ type: "cache-remove", key: entry.key }]);
	return t;
}

// ── The store reducer ────────────────────────────────────────────────────────────────────────────

/** The empty store of a viewer. */
export function initialDraftsState(viewerId: string | null): DraftsState {
	return { viewerId, scope: null, generation: 0, pageOrg: null, activeKey: {}, entries: {} };
}

/**
 * True when an entry is D1's `none`: no thread, no content, no row and no send. New chat on it would
 * only add clutter. An open conversation with no draft (`listed`, `unlisted`, `deleted`) is not.
 */
function isBlank(entry: DraftEntry): boolean {
	return (
		entry.thread === "none" &&
		entry.server === null &&
		(entry.local === null || isEmptyContent(entry.local)) &&
		entry.claiming === null &&
		entry.sending === null &&
		entry.pendingFailedSend === null
	);
}

/** Puts one entry back into the store, or removes it. */
function putEntry(state: DraftsState, id: string, entry: DraftEntry | null): DraftsState {
	const entries = { ...state.entries };
	if (entry === null) delete entries[id];
	else entries[id] = entry;
	return { ...state, entries };
}

/** The context a key's own reduction gets from the store. */
function contextFor(state: DraftsState, key: DraftKey, env: DraftsEnv): DraftEntryContext {
	return {
		pageOrg: state.pageOrg,
		tabId: env.tabId,
		active: state.activeKey[scopeId(key)] === key.conversationId,
		now: env.now,
	};
}

/** Runs one key's event through `reduceDraftEntry` and writes back that key alone. */
function applyToEntry(
	state: DraftsState,
	key: DraftKey,
	event: DraftEntryEvent,
	env: DraftsEnv,
): DraftsTransition {
	const id = keyId(key);
	const entry = state.entries[id];
	if (entry === undefined) return { state, effects: [] };
	const t = reduceDraftEntry(entry, event, contextFor(state, entry.key, env));
	const next = putEntry(state, id, t.entry);
	const sid = scopeId(entry.key);
	if (t.entry !== null || next.activeKey[sid] !== entry.key.conversationId)
		return { state: next, effects: t.effects };
	// The active key's entry was removed (D16 "Let it go"): the scope has no active key, so the next
	// New chat mints one (D2) instead of pointing the box at an entry that no longer exists.
	const activeKey = { ...next.activeKey };
	delete activeKey[sid];
	return { state: { ...next, activeKey }, effects: t.effects };
}

/**
 * The store reduction: D1-D4, D23, D25 and D29 here, and every key-addressed event through
 * `reduceDraftEntry` for that key only.
 */
export function reduceDrafts(
	state: DraftsState,
	event: DraftsEvent,
	env: DraftsEnv,
): DraftsTransition {
	switch (event.type) {
		case "OPEN_NEW": {
			const scope = state.scope;
			if (scope === null) return { state, effects: [] };
			const sid = scopeId(scope);
			const activeId = state.activeKey[sid];
			if (activeId !== undefined) {
				const active = state.entries[keyId({ ...scope, conversationId: activeId })];
				if (active !== undefined && isBlank(active)) return { state, effects: [] }; // D1
			}
			// D2: a new key; the old entry is untouched. An id this tab already holds is not fresh,
			// and never replaces that entry.
			const key: DraftKey = { ...scope, conversationId: event.conversationId };
			if (state.entries[keyId(key)] !== undefined) return { state, effects: [] };
			const next = putEntry(state, keyId(key), newEntry(key, "none"));
			return {
				state: { ...next, activeKey: { ...next.activeKey, [sid]: key.conversationId } },
				effects: [],
			};
		}
		case "OPEN_ARTIFACT_NEW": {
			// D3: a new key whose content is the artifact placement, saved; no thread row is created.
			const scope = state.scope;
			if (scope === null) return { state, effects: [] };
			const key: DraftKey = { ...scope, conversationId: event.conversationId };
			if (state.entries[keyId(key)] !== undefined) return { state, effects: [] };
			const entry: DraftEntry = {
				...newEntry(key, "none"),
				local: { ...EMPTY_CONTENT, artifacts: [event.artifactId] },
			};
			const activated: DraftsState = {
				...putEntry(state, keyId(key), entry),
				activeKey: { ...state.activeKey, [scopeId(scope)]: key.conversationId },
			};
			return applyToEntry(activated, key, { type: "SAVE_TRIGGER", reason: "timer" }, env);
		}
		case "SELECT": {
			// D4
			if (state.scope === null || !sameScope(event.key, state.scope)) return { state, effects: [] };
			const id = keyId(event.key);
			const existing = state.entries[id] ?? newEntry(event.key, event.thread);
			const stored = existing.thread === "listed" || existing.thread === "unlisted";
			const entry: DraftEntry = { ...existing, transcript: stored ? "loading" : "loaded" };
			const next = putEntry(state, id, entry);
			return {
				state: {
					...next,
					activeKey: { ...next.activeKey, [scopeId(event.key)]: event.key.conversationId },
				},
				effects: stored ? [{ type: "load-transcript", key: event.key }] : [],
			};
		}
		case "SCOPE_CHANGE": {
			// D23: the selector shows only the new scope; a late list for the old one is dropped by
			// its generation. An org change is also PAGE_ORG(null) (D29), at once.
			const orgChanged = state.scope === null || state.scope.orgId !== event.scope.orgId;
			const generation = state.generation + 1;
			return {
				state: {
					...state,
					scope: event.scope,
					generation,
					pageOrg: orgChanged ? null : state.pageOrg,
				},
				effects: [{ type: "list", scope: event.scope, generation }],
			};
		}
		case "PAGE_ORG": {
			// D29: with an id, every key of that org that is held for `other-org`, or blocked for its
			// address, resumes and saves.
			let next: DraftsState = { ...state, pageOrg: event.orgId };
			const effects: DraftEffect[] = [];
			if (event.orgId === null) return { state: next, effects };
			for (const [id, entry] of Object.entries(state.entries)) {
				if (entry.key.orgId !== event.orgId) continue;
				const reason = entry.blockedBy?.kind;
				const resumable =
					(entry.save === "held" && reason === "other-org") ||
					(entry.save === "blocked" && reason === "address");
				if (!resumable) continue;
				const resumed: DraftEntry = { ...entry, save: "idle", blockedBy: null };
				const t = reduceDraftEntry(
					resumed,
					{ type: "SAVE_TRIGGER", reason: "timer" },
					contextFor(next, entry.key, env),
				);
				next = putEntry(next, id, t.entry);
				effects.push(...t.effects);
			}
			return { state: next, effects };
		}
		case "VIEWER_CHANGE":
			// D25: memory and every cache item are cleared.
			if (event.viewerId === state.viewerId) return { state, effects: [] };
			return {
				state: { ...state, viewerId: event.viewerId, activeKey: {}, entries: {} },
				effects: [{ type: "cache-clear" }],
			};
		case "ENTRY":
			return applyToEntry(state, event.key, event.event, env);
	}
}
