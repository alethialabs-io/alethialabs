// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a draft's status says (ADR 0001 §7.2, §7.4), as pure functions of the store's state, so the
// words are decided in one place and every one of them is testable without rendering.
//
// Three surfaces read from here:
// - the BAR above the box (`barOf`): a decision the user has to make (a conflict, a copy that came
//   back, a message that may already have been sent, a credential-looking paste) or a state that
//   holds the box (a send in flight, another tab's claim);
// - the NOTICE lines under that bar (`noticeLines`): what the store said about this draft since its
//   last send, each once, a refused send's reason first;
// - the FOOTER under the box (`footerOf`): the save state of the key, which never says "Saved"
//   unless the server acknowledged exactly what the box shows.
//
// The notices that only report an unsaved state (G19: `unsaved`, `held-other-org`, `blocked`,
// `credential`) are not lines here: the footer states that state for as long as it lasts, and the
// drafts host raises the once-per-entry toast that names the conversation.

import { isEmptyContent, keyId, shownContent } from "@/lib/stores/elench-drafts/reducer-drafting";
import { isUnacknowledged } from "@/lib/stores/elench-drafts/selectors";
import type { DraftNoticeItem, DraftsView } from "@/lib/stores/elench-drafts/store";
import type { DraftEntry, DraftKey } from "@/lib/stores/elench-drafts/types";

/** A notice the store raises (§7.4). */
type DraftNoticeKind = DraftNoticeItem["notice"];

// ── The words ───────────────────────────────────────────────────────────────────────────────

/** Every sentence the bar, the lines and the footer say (§7.2, §7.4), each in one place. */
export const COPY = {
	sending: "Sending…",
	checking: "Not sent yet. Checking…",
	claimed: "Being sent from another tab or device.",
	edited: "Changed in another tab or device.",
	sentElsewhere: "This message was sent from another tab or device.",
	discarded: "Discarded in another tab or device.",
	uncertain:
		"This message may already have been sent: the tab that sent it stopped confirming. Check the conversation before you send it again.",
	copyCameBack:
		"This message was sent, and a copy came back to the draft because the send took too long to confirm.",
	credential: "Not saved to your account: this looks like a credential.",
	notSent: "Not sent. Your message is back in the box.",
	emptyBox: "The box is empty, so nothing was sent.",
	waitForSend: "Wait for the message that is being sent.",
	transcriptStale: "This conversation has newer messages. They are shown now. Press Enter to send.",
	transcriptElsewhere:
		"This conversation has messages from another tab or device. They are shown now. Press Enter to send.",
	firstSent: "Your first message was sent.",
	firstSentMoreInBox: "Your first message was sent. The text you typed after it is still in the box.",
	keptInNewDeleted: "That conversation was deleted. Your message is kept in a new one.",
	keptInNewStarted: "This conversation was started from another tab or device. Your message is kept in a new one.",
	earlierVersionSent:
		"An earlier version of this message was already sent. It is shown above. Your edit is still in the box.",
	beingAnswered: "Being answered in another tab or device.",
	threadBusy: "Another message in this conversation is being answered",
	reloadToContinue: "This tab runs an older version of Elench. Reload the page to continue.",
	discardConflict: "Not discarded: this message changed in another tab or device.",
	discardFailed: "Not discarded: something went wrong. Your message is still here.",
	deletedUnsentRemoved: "Removed the unsent message of a conversation you deleted.",
	saved: "Saved",
	saving: "Saving…",
	retrying: "Not saved to your account yet. Kept in this tab. Retrying.",
	retryingUncached: "Not saved. This tab can't keep it either. Copy it before you close the tab.",
	unauthorized: "Not saved: you are signed out. Sign in again in this tab to save it.",
	membership:
		"Not saved: you are no longer an active member of this organization. Copy your message; it is kept in this tab only.",
	forbidden: "Not saved: you can no longer write here.",
	limit: "Not saved: you have 200 unsent messages here. Send or discard some to save this one.",
	error: "Not saved: something went wrong saving this message. It is kept in this tab only.",
	address: "This organization's address changed. Open it at its new address in this tab to save.",
	addressReopen: "This organization's address changed. Open Elench again to save.",
	keptInTab: "Kept in this tab only. Not saved to your account.",
} as const;

/** "Not saved yet: this tab shows another organization. …" naming the org when it is known (D24). */
export function heldOtherOrgText(orgName: string | null): string {
	const where = orgName === null ? "that organization" : orgName;
	return `Not saved yet: this tab shows another organization. It saves when you go back to ${where} in this tab.`;
}

/**
 * Why a send did not go out, by the code its release or its failed-send marker recorded, for the
 * codes nothing else on screen explains. A typed refusal with a notice of its own (`thread-busy`,
 * `transcript-stale`, `client-outdated`), an untyped status the chat's own error card names (402
 * budget, 413 length, 503 missing key), and a send that MAY have gone out (the bar, D31) are not
 * here; neither is `error`, which carries no reason.
 */
const NOT_SENT_REASONS: ReadonlyMap<string, string> = new Map(Object.entries({
	unauthorized: "You are signed out. Sign in again in this tab to send it.",
	forbidden: "You can no longer write here.",
	"scope-changed": "This tab now shows another organization.",
	"rate-limited": "Too many requests. Wait a moment, then press Enter to send.",
	unavailable: "The service did not answer.",
	invalid: "This message could not be read.",
	limit: "You have 200 unsent messages here.",
	"draft-conflict": "This message changed in another tab or device.",
	timeout: "Starting the conversation took longer than 30 seconds.",
	reload: "The page was reloaded before the message was sent.",
	"thread-not-found": "This conversation no longer exists.",
	"project-not-found": "This project no longer exists.",
	"org-forbidden": "You are not an active member of this organization.",
	// The chat's own card reads these two as a generic error, so the reason is said here.
	"status-400": "Elench could not read this message.",
	"status-401": "You are signed out. Sign in again in this tab to send it.",
}));

/** Every sentence `notSentReason` can answer. */
const REASONS: ReadonlySet<string> = new Set(NOT_SENT_REASONS.values());

/** The reason a send recorded under `code` did not go out, or null when nothing needs saying. */
export function notSentReason(code: string): string | null {
	return NOT_SENT_REASONS.get(code) ?? null;
}

// ── The bar ─────────────────────────────────────────────────────────────────────────────────

/** The longest excerpt of a text the conflict bar quotes. */
const EXCERPT_CHARS = 60;

/** The first `EXCERPT_CHARS` characters of `text` on one line, with an ellipsis when cut. */
export function excerpt(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= EXCERPT_CHARS ? line : `${line.slice(0, EXCERPT_CHARS).trimEnd()}…`;
}

/** What the bar above the box shows for one key. */
export type DraftBar =
	/** A claim, a start, or a send before its hand-off: the box is frozen (D9, D10, D11). */
	| { kind: "sending"; text: string }
	/** D30: another tab or device holds the claim. */
	| { kind: "claimed" }
	/** D15: another tab or device saved over this tab's base. */
	| { kind: "edited"; sentElsewhere: boolean; mine: string; theirs: string }
	/** D16: discarded elsewhere. */
	| { kind: "discarded" }
	/** D31: a send may already have gone out. */
	| { kind: "uncertain" }
	/** D9c: the lease released a sent message's text back into the draft. */
	| { kind: "copy-came-back" }
	/** D36: the autosave is held until the user answers. */
	| { kind: "credential" };

/** The bar `entry` shows, or null. The order is the order of what holds the box. */
export function barOf(entry: DraftEntry, keptInTab: boolean): DraftBar | null {
	if (entry.claiming !== null) return { kind: "sending", text: COPY.sending };
	const phase = entry.sending?.phase;
	if (phase === "starting") return { kind: "sending", text: COPY.sending };
	if (phase === "releasing") return { kind: "sending", text: COPY.checking };
	const conflict = entry.conflict;
	if (conflict?.kind === "claimed") return { kind: "claimed" };
	if (conflict?.kind === "uncertain") return conflict.row === null ? { kind: "uncertain" } : { kind: "copy-came-back" };
	if (conflict?.kind === "edited") {
		const row = conflict.row;
		const ours = entry.server?.lastSent?.turnId ?? null;
		const theirs = row?.lastSent?.turnId ?? null;
		return {
			kind: "edited",
			sentElsewhere: theirs !== null && theirs !== ours,
			mine: excerpt(shownContent(entry).text),
			theirs: excerpt(row?.content.text ?? ""),
		};
	}
	if (conflict?.kind === "discarded") return { kind: "discarded" };
	if (entry.save === "held" && entry.blockedBy?.kind === "credential" && !keptInTab) return { kind: "credential" };
	return null;
}

/** The sentence a bar leads with. */
export function barText(bar: DraftBar): string {
	switch (bar.kind) {
		case "sending":
			return bar.text;
		case "claimed":
			return COPY.claimed;
		case "edited":
			return bar.sentElsewhere ? COPY.sentElsewhere : COPY.edited;
		case "discarded":
			return COPY.discarded;
		case "uncertain":
			return COPY.uncertain;
		case "copy-came-back":
			return COPY.copyCameBack;
		case "credential":
			return COPY.credential;
	}
}

// ── The notice lines ────────────────────────────────────────────────────────────────────────

/** The line one send notice says. `stale` tells D9d (a)'s transcript-stale from D9a's load. */
function noticeLine(notice: DraftNoticeKind, stale: boolean): string | null {
	switch (notice) {
		case "not-sent":
			return COPY.notSent;
		case "empty-box":
			return COPY.emptyBox;
		case "wait-for-send":
			return COPY.waitForSend;
		case "transcript-shown":
			return stale ? COPY.transcriptStale : COPY.transcriptElsewhere;
		case "first-sent":
			return COPY.firstSent;
		case "first-sent-more-in-box":
			return COPY.firstSentMoreInBox;
		case "sent-elsewhere":
			return COPY.sentElsewhere;
		case "kept-in-new-deleted":
			return COPY.keptInNewDeleted;
		case "kept-in-new-started":
			return COPY.keptInNewStarted;
		case "earlier-version-sent":
			return COPY.earlierVersionSent;
		case "being-answered":
			return COPY.beingAnswered;
		case "thread-busy":
			return COPY.threadBusy;
		case "reload-to-continue":
			return COPY.reloadToContinue;
		case "discard-conflict":
			return COPY.discardConflict;
		case "discard-failed":
			return COPY.discardFailed;
		case "deleted-unsent-removed":
			return COPY.deletedUnsentRemoved;
		// The bar states another tab's claim for as long as it lasts (D30).
		case "claimed-elsewhere":
			return null;
		// G19's notices: the footer and the host's toast say them.
		case "unsaved":
		case "held-other-org":
		case "blocked":
		case "credential":
			return null;
	}
}

/** The notices that say a send went out after all, so an earlier "Not sent" is no longer true. */
const SENT_AFTER_ALL: ReadonlySet<DraftNoticeKind> = new Set<DraftNoticeKind>([
	"first-sent",
	"first-sent-more-in-box",
	"sent-elsewhere",
]);

/** Removes "Not sent" and the reason said before it from `lines`. */
function dropNotSent(lines: string[]): void {
	const at = lines.indexOf(COPY.notSent);
	if (at === -1) return;
	const reason = at > 0 && REASONS.has(lines[at - 1] ?? "");
	lines.splice(reason ? at - 1 : at, reason ? 2 : 1);
}

/** The most notice lines shown at once: the newest, so a reason and its outcome both show. */
const MAX_LINES = 3;

/**
 * The lines the store said about `key` since its last send, oldest first, each once, at most
 * `MAX_LINES`. A "Not sent" line is preceded by its reason when only the recorded failure code
 * names it (`notSentReason`). A transcript load raised with a "Not sent" is the route's
 * transcript-stale refusal; raised alone it is D9a's load before a send.
 *
 * A send that failed for certain also leaves its marker on the row (§5.4), so "Not sent" is said
 * from the marker too: after a reload, or on another tab or device, where no notice was raised,
 * the words are in the box and the card says why (§7.5). A send that MAY have gone out is the
 * bar's (D31), never "Not sent".
 */
export function noticeLines(view: DraftsView, key: DraftKey): string[] {
	const id = keyId(key);
	const mine = view.notices.filter((n) => keyId(n.key) === id).map((n) => n.notice);
	const stale = mine.includes("not-sent");
	const entry = view.drafts.entries[id];
	const failed = entry?.pendingFailedSend ?? entry?.server?.failedSend ?? null;
	const code = failed?.error ?? null;
	const lines: string[] = [];
	const push = (line: string): void => {
		const at = lines.indexOf(line);
		if (at !== -1) lines.splice(at, 1);
		lines.push(line);
	};
	/** "Not sent", after its reason when the recorded code names one. */
	const notSent = (): void => {
		const reason = code === null ? null : notSentReason(code);
		if (reason !== null) push(reason);
		push(COPY.notSent);
	};
	if (entry !== undefined && failed !== null && !failed.uncertain && !stale && !isEmptyContent(shownContent(entry)))
		notSent();
	for (const n of mine) {
		if (n === "not-sent") {
			notSent();
			continue;
		}
		// A send learned to have gone out after all supersedes an earlier "Not sent" (D17, D30).
		if (SENT_AFTER_ALL.has(n)) dropNotSent(lines);
		const line = noticeLine(n, stale);
		if (line !== null) push(line);
	}
	return lines.slice(-MAX_LINES);
}

// ── The footer ──────────────────────────────────────────────────────────────────────────────

/** The footer's dot: what the save state is, in the console's grayscale status vocabulary. */
type FooterTier = "active" | "pending" | "failed" | "idle";

/** What the footer under the box shows for one key. */
export interface DraftFooter {
	tier: FooterTier;
	text: string;
	/** D24's new address, for an `address` block: the same path under the returned slug. */
	address?: string;
}

/** `pathname` with its org segment (the first) replaced by `slug`. */
function addressUnder(pathname: string, slug: string): string {
	const parts = pathname.split("/");
	if (parts.length < 2 || parts[1] === "") return `/${slug}`;
	parts[1] = slug;
	return parts.join("/");
}

/** Facts about the tab the footer needs beyond the entry. */
export interface FooterContext {
	/** This tab's cache refused the key's last write (§7.4: "this tab can't keep it either"). */
	uncached: boolean;
	/** The user chose "Keep in this tab only" for this key's credential notice (D36). */
	keptInTab: boolean;
	/** The name of the key's org, for D24's other-org hold. */
	orgName: string | null;
	/** The page's path, for D24's new address. */
	pathname: string;
}

/**
 * The footer status of `entry` (§7.4), or null when there is nothing to say. "Saved" is not decided
 * here: it is shown for 2 s after a save is acknowledged, which only the rendered footer can time.
 */
export function footerOf(entry: DraftEntry, ctx: FooterContext): DraftFooter | null {
	const reason = entry.blockedBy;
	if (entry.save === "blocked" && reason !== null) {
		switch (reason.kind) {
			case "unauthorized":
				return { tier: "failed", text: COPY.unauthorized };
			case "forbidden":
				return { tier: "failed", text: reason.membership ? COPY.membership : COPY.forbidden };
			case "limit":
				return { tier: "failed", text: COPY.limit };
			case "address":
				// A13: in community every org is `~`, and there is no other address to offer.
				return reason.slug === "~"
					? { tier: "failed", text: COPY.addressReopen }
					: { tier: "failed", text: COPY.address, address: addressUnder(ctx.pathname, reason.slug) };
			default:
				return { tier: "failed", text: COPY.error };
		}
	}
	if (entry.save === "held") {
		if (reason?.kind === "other-org") return { tier: "idle", text: heldOtherOrgText(ctx.orgName) };
		// The credential notice is the bar until the user answers it (D36).
		if (reason?.kind === "credential") return ctx.keptInTab ? { tier: "idle", text: COPY.keptInTab } : null;
	}
	if (entry.save === "retrying")
		return { tier: "pending", text: ctx.uncached ? COPY.retryingUncached : COPY.retrying };
	if (entry.inflight !== null) return { tier: "pending", text: COPY.saving };
	return null;
}

/**
 * True when the footer may say "Saved" for `entry` (§7.4): nothing is on the wire, nothing is
 * unsaved, no conflict is open, and the box shows exactly the server's content.
 */
export function isAcknowledged(entry: DraftEntry): boolean {
	return (
		entry.save === "idle" &&
		entry.inflight === null &&
		entry.local === null &&
		entry.conflict === null &&
		entry.claiming === null &&
		entry.sending === null &&
		entry.server !== null
	);
}

// ── Leaving: the sign-out confirm and `beforeunload` ────────────────────────────────────────

/**
 * How many keys hold words the server has not acknowledged (D25): unsaved edits, a held or blocked
 * save, a claim or a send in flight. A sign-out loses every one of them.
 */
export function unsavedCount(view: DraftsView): number {
	return Object.values(view.drafts.entries).filter(isUnacknowledged).length;
}

/** "N messages are not saved to your account yet and will be lost." (D25), in the right number. */
export function signOutWarning(count: number): string {
	return count === 1
		? "1 message is not saved to your account yet and will be lost."
		: `${count} messages are not saved to your account yet and will be lost.`;
}

/**
 * True when a close of this tab would lose words that are unsaved for a longer reason than the
 * debounce (§7.5, Q4): a key held for another org (D24) or for a credential (D36), a key that is
 * blocked, or a retrying key this tab's cache refused.
 */
export function asksBeforeUnload(view: DraftsView): boolean {
	return Object.entries(view.drafts.entries).some(
		([id, e]) =>
			!isEmptyContent(shownContent(e)) &&
			(e.save === "held" || e.save === "blocked" || (e.save === "retrying" && view.uncached[id] === true)),
	);
}

/** The name a toast gives a conversation (G19): its title, or what it is when it has none yet. */
export function conversationName(entry: DraftEntry | undefined): string {
	const title = entry?.server?.title ?? null;
	return title === null || title.trim() === "" ? "New conversation" : title;
}
