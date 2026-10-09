"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two mount points of a draft's status (ADR 0001 §7.4, §14 slice 9). The composer renders both,
// wherever it is mounted (the modal landing and the docked chat): the bar slot above the box and
// the footer slot under it, so slice 11 can fill them without touching the composer.
//
// Until slice 11 designs them, the bar slot carries an INTERIM status: plain lines, in the style the
// conversation already uses for a refusal's status line, saying what the store said about this
// draft since its last send (a send that did not go out and why, a send in flight, another tab's
// claim) — so no refused or failed send is silent. Slice 11 replaces it with the bars, their actions and the
// footer status of §7.4. The footer slot renders nothing until then.

import { useCallback, useSyncExternalStore } from "react";
import { keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import { selectDraft } from "@/lib/stores/elench-drafts/selectors";
import type { DraftNoticeItem, DraftsView } from "@/lib/stores/elench-drafts/store";
import type { DraftEntry, DraftKey } from "@/lib/stores/elench-drafts/types";
import { useElenchDraft } from "../use-elench-send";

/** Where one draft's status is rendered: the key it reports on. */
export interface DraftSlotProps {
	draftKey: DraftKey;
}

/** The interim words of each notice the store raises (ADR 0001 §7.2, §7.4). */
const NOTICE_COPY: Record<DraftNoticeItem["notice"], string> = {
	"not-sent": "Not sent. Your message is back in the box.",
	"empty-box": "The box is empty, so nothing was sent.",
	"wait-for-send": "Wait for the message that is being sent.",
	"transcript-shown":
		"This conversation has newer messages. They are shown now. Press Enter to send.",
	"first-sent": "Your first message was sent.",
	"first-sent-more-in-box":
		"Your first message was sent. The text you typed after it is still in the box.",
	"sent-elsewhere": "This message was sent from another tab or device.",
	"claimed-elsewhere": "Being sent from another tab or device.",
	"kept-in-new-deleted": "That conversation was deleted. Your message is kept in a new one.",
	"kept-in-new-started":
		"This conversation was started from another tab or device. Your message is kept in a new one.",
	"earlier-version-sent":
		"An earlier version of this message was already sent. It is shown above. Your edit is still in the box.",
	"being-answered": "Being answered in another tab or device",
	"thread-busy": "Another message in this conversation is being answered",
	"reload-to-continue": "Reload to continue",
	"discard-conflict": "Not discarded: this message changed in another tab or device.",
	"discard-failed": "Not discarded: something went wrong. Your message is still here.",
	unsaved: "Not saved to your account yet. Kept in this tab. Retrying.",
	"held-other-org":
		"Not saved yet: this tab shows another organization. It saves when you go back to it in this tab.",
	blocked: "Not saved: something went wrong saving this message. It is kept in this tab only.",
	credential: "Not saved to your account: this looks like a credential. It is kept in this tab only.",
	"deleted-unsent-removed": "Removed the unsent message of a conversation you deleted.",
};

/** The line a draft's own state says, which outranks any notice while it lasts (§7.4). */
function stateLine(entry: DraftEntry): string | null {
	if (entry.claiming !== null) return "Sending…";
	const phase = entry.sending?.phase;
	if (phase === "starting") return "Sending…";
	if (phase === "releasing") return "Not sent yet. Checking…";
	if (entry.conflict?.kind === "claimed") return "Being sent from another tab or device.";
	if (entry.conflict?.kind === "uncertain")
		return entry.conflict.row === null
			? "This message may already have been sent: the tab that sent it stopped confirming. Check the conversation before you send it again."
			: "This message was sent, and a copy came back to the draft because the send took too long to confirm.";
	if (entry.conflict?.kind === "edited") return "Changed in another tab or device.";
	if (entry.conflict?.kind === "discarded") return "Discarded in another tab or device.";
	return null;
}

/** The most lines the interim status shows at once: the newest, so a reason and its outcome both show. */
const MAX_LINES = 3;

/**
 * The interim lines for `key`: its state's line while it lasts, else what the store said since the
 * last send of this draft (a refusal's reason, then where the words are), oldest first, each once.
 * A new send acknowledges them (`useElenchSend`). Empty when there is nothing to say.
 */
function draftStatusLines(view: DraftsView, key: DraftKey): string[] {
	const entry = selectDraft(view, key);
	const fromState = entry === null ? null : stateLine(entry);
	if (fromState !== null) return [fromState];
	const id = keyId(key);
	const lines: string[] = [];
	for (const n of view.notices) {
		if (keyId(n.key) !== id) continue;
		const line = NOTICE_COPY[n.notice];
		const at = lines.indexOf(line);
		if (at !== -1) lines.splice(at, 1);
		lines.push(line);
	}
	return lines.slice(-MAX_LINES);
}

/** Subscribes to nothing: without a draft the line never changes. */
function subscribeNothing(): () => void {
	return () => undefined;
}

/**
 * The composer footer's status line (§7.4: "Saved", "Saving…", "Not saved …"). Renders nothing
 * until slice 11 fills it.
 */
export function DraftFooterSlot(_props: DraftSlotProps): null {
	return null;
}

/**
 * The bar above the composer. Until slice 11 replaces it with the conflict, claimed, uncertain and
 * credential bars and the notices of D9a, D24, D31 and D36, it shows the interim status line.
 */
export function DraftBarSlot({ draftKey }: DraftSlotProps) {
	const draft = useElenchDraft();
	const subscribe = useCallback(
		(onChange: () => void) => (draft === null ? subscribeNothing() : draft.store.view.subscribe(onChange)),
		[draft],
	);
	// Joined, so the snapshot is a stable string and a store change that says nothing new re-renders nothing.
	const snapshot = useCallback(
		() => (draft === null ? "" : draftStatusLines(draft.store.view.getState(), draftKey).join("\n")),
		[draft, draftKey],
	);
	const joined = useSyncExternalStore(subscribe, snapshot, snapshot);
	if (joined === "") return null;
	return (
		<div role="status" data-testid="elench-draft-status" className="px-1 pb-2">
			{joined.split("\n").map((line) => (
				<p key={line} className="text-ui-sm text-muted-foreground">
					{line}
				</p>
			))}
		</div>
	);
}
