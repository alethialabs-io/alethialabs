"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Two pieces of tab state the draft status needs outside the conversation that renders it:
//
// - the tab's drafts store, for the account menu's sign-out confirm (D25). The menu is in the
//   sidebar, which is not inside the drafts root's provider, so the drafts host (mounted by the root
//   once per tab) registers the store here;
// - the keys whose credential notice the user answered "Keep in this tab only" (D36). The answer is
//   the user's for this tab: it outlives a remount of the composer, and nothing is sent anywhere.

import { useSyncExternalStore } from "react";
import type { DraftsStoreHandle } from "@/lib/stores/elench-drafts/store";

/** A value and the listeners to tell when it changes. */
function cell<T>(initial: T) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: (): T => value,
		set(next: T): void {
			if (Object.is(next, value)) return;
			value = next;
			for (const l of [...listeners]) l();
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

const mounted = cell<DraftsStoreHandle | null>(null);
const keptInTab = cell<ReadonlySet<string>>(new Set());

/** Registers the tab's drafts store (the host does, while it is mounted); returns the removal. */
export function registerDraftsStore(store: DraftsStoreHandle): () => void {
	mounted.set(store);
	return () => {
		if (mounted.get() === store) mounted.set(null);
	};
}

/** The tab's drafts store, or null before the drafts root has one (and on the server). */
export function useRegisteredDraftsStore(): DraftsStoreHandle | null {
	return useSyncExternalStore(mounted.subscribe, mounted.get, () => null);
}

/** Records the user's "Keep in this tab only" for the key `id` (D36). */
export function keepInTab(id: string): void {
	const next = new Set(keptInTab.get());
	next.add(id);
	keptInTab.set(next);
}

/** Forgets the answer for `id`: its credential notice is asked again the next time it is held. */
export function forgetKeptInTab(id: string): void {
	if (!keptInTab.get().has(id)) return;
	const next = new Set(keptInTab.get());
	next.delete(id);
	keptInTab.set(next);
}

/** Whether the user chose "Keep in this tab only" for the key `id`. */
export function useKeptInTab(id: string): boolean {
	const has = (): boolean => keptInTab.get().has(id);
	return useSyncExternalStore(keptInTab.subscribe, has, () => false);
}
