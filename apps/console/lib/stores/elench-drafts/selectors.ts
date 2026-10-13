"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The read side of the Elench drafts store (ADR 0001 §7, §7.4): `useDraft(key)` for the composer
// and `useUnsent(scope)` for the Unsent group. Pure selectors plus the two hooks over them; nothing
// renders them yet (the composer is slice 9's, the Unsent group slice 10's).

import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { isEmptyContent, keyId, scopeId, shownContent } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { DraftsStoreHandle, DraftsView } from "@/lib/stores/elench-drafts/store";
import type { DraftEntry, DraftKey, DraftScope } from "@/lib/stores/elench-drafts/types";

/** One key's entry, or null when this tab holds none. */
export function selectDraft(view: DraftsView, key: DraftKey): DraftEntry | null {
	return view.drafts.entries[keyId(key)] ?? null;
}

/**
 * True when the server has not acknowledged what this key's box holds (§7.4): unsaved edits, a
 * claim or a send in flight, an external send's failed prompt, or a save that is retrying, held or
 * blocked. This is the count the rail's Unsent group shows.
 */
export function isUnacknowledged(entry: DraftEntry): boolean {
	return (
		entry.local !== null ||
		entry.claiming !== null ||
		entry.sending !== null ||
		entry.pendingFailedSend !== null ||
		entry.save === "retrying" ||
		entry.save === "held" ||
		entry.save === "blocked"
	);
}

/**
 * True when a key holds words that were never sent: a box with content, a claim or send in flight,
 * or a failed-send marker. A discarded row is not unsent.
 */
function holdsUnsentWords(entry: DraftEntry): boolean {
	if (entry.server?.state === "discarded" && entry.local === null) return false;
	return (
		!isEmptyContent(shownContent(entry)) ||
		entry.claiming !== null ||
		entry.sending !== null ||
		entry.pendingFailedSend !== null ||
		(entry.server?.failedSend ?? null) !== null
	);
}

/** The keys of `scope` that hold unsent words, in a stable order (by key id). */
export function selectUnsent(view: DraftsView, scope: DraftScope): DraftEntry[] {
	const sid = scopeId(scope);
	return Object.entries(view.drafts.entries)
		.filter(([, e]) => scopeId(e.key) === sid && holdsUnsentWords(e))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, e]) => e);
}

/** True when this tab's cache refused the key's last write: "this tab can't keep it either" (§7.4). */
export function selectCacheRefused(view: DraftsView, key: DraftKey): boolean {
	return view.uncached[keyId(key)] === true;
}

/** The composer's view of one key: its entry, or null. */
export function useDraft(store: DraftsStoreHandle, key: DraftKey): DraftEntry | null {
	return useStore(store.view, (s) => selectDraft(s, key));
}

/** The Unsent group of one scope. */
export function useUnsent(store: DraftsStoreHandle, scope: DraftScope): DraftEntry[] {
	return useStore(store.view, useShallow((s: DraftsView) => selectUnsent(s, scope)));
}
