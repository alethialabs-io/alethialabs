"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The draft status that is not tied to a mounted composer (ADR 0001 §7.4, §7.5, D25). Mounted once
// per tab by the drafts root, whether or not the Elench surface is open, because a key can become
// unsaved while nobody is looking at it:
//
// - G19: a toast each time a key ENTERS an unsaved, held or blocked state, naming the conversation.
//   The reducer raises one notice per entry; this shows it and acknowledges it by id, so a notice is
//   never shown twice and one not yet shown is never dropped. The footer states the state for as
//   long as it lasts; a conversation that was deleted elsewhere is toasted too (D19), since its box
//   may never be on screen again.
// - `beforeunload` asks before a close when a key is unsaved for a longer reason than the debounce
//   (§7.5, Q4: held, blocked, or retrying with a cache that refused it).
// - the tab's store is registered for the account menu's sign-out confirm (D25).

import { useEffect } from "react";
import { toast } from "sonner";
import { keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { DraftNoticeItem, DraftsStoreHandle, DraftsView } from "@/lib/stores/elench-drafts/store";
import { asksBeforeUnload, conversationName, COPY, footerOf, heldOtherOrgText } from "./copy";
import { registerDraftsStore } from "./registry";

/** What a toast for `notice` says, or null when the notice is not the host's to show. */
export function toastText(view: DraftsView, notice: DraftNoticeItem): string | null {
	const entry = view.drafts.entries[keyId(notice.key)];
	switch (notice.notice) {
		case "unsaved":
			return view.uncached[keyId(notice.key)] === true ? COPY.retryingUncached : COPY.retrying;
		case "held-other-org":
			return heldOtherOrgText(null);
		case "credential":
			return COPY.credential;
		case "blocked": {
			const footer =
				entry === undefined
					? null
					: footerOf(entry, { uncached: false, keptInTab: false, orgName: null, pathname: "/" });
			return footer?.text ?? COPY.error;
		}
		case "deleted-unsent-removed":
			return COPY.deletedUnsentRemoved;
		default:
			return null;
	}
}

/** Shows the host's notices as toasts and acknowledges them. */
function toastNotices(store: DraftsStoreHandle, view: DraftsView): void {
	const shown: number[] = [];
	for (const n of view.notices) {
		const text = toastText(view, n);
		if (text === null) continue;
		shown.push(n.id);
		toast(conversationName(view.drafts.entries[keyId(n.key)]), { description: text, id: `elench-draft-${n.id}` });
	}
	if (shown.length > 0) store.ackNotices(shown);
}

/** The tab-wide half of the draft status; renders nothing. */
export function DraftStatusHost({ store }: { store: DraftsStoreHandle }): null {
	useEffect(() => registerDraftsStore(store), [store]);

	useEffect(() => {
		toastNotices(store, store.view.getState());
		return store.view.subscribe((view) => toastNotices(store, view));
	}, [store]);

	useEffect(() => {
		/** Asks the browser to confirm the close while words would be lost (§7.5). */
		const onBeforeUnload = (e: BeforeUnloadEvent): void => {
			if (!asksBeforeUnload(store.view.getState())) return;
			e.preventDefault();
			// Older browsers read the prompt from here; every current one shows its own words.
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [store]);

	return null;
}
