"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `/` focuses the list page's search (polish-wave spec §3, #7737).
//
// The key is the registry row `list.search` (scope `list`, a bare `/`), answered through
// `useShortcut` — so the shell's one `keydown` listener handles it, and the registry's rules apply:
// a bare key never fires while the focus is in a field or inside a dialog or menu, so `/` stays
// typeable everywhere it is typed. The `list` scope is "on" exactly while this hook is mounted, the
// same way the board's `canvas` keys are on while the board's `useShortcut` calls are.
//
// `@repo/ui`'s `ListToolbar` cannot import the registry, so it takes the two halves this hook
// returns: the input ref the shortcut focuses, and the hint to draw. The hint is `undefined` on the
// server render and the render that hydrates it (`useShortcutLabel`), so a hint is only ever shown
// for a binding that is live in this browser.
//
// One per page: two mounted copies would both answer `/` (the most recently mounted wins), so call
// it in the component that renders the page's one `ListToolbar`.

import type { FilterSearchShortcut } from "@repo/ui/filter-search";
import { type RefObject, useRef } from "react";
import { ariaKeyShortcuts, useShortcutLabel } from "@/components/shell/shortcut-hint";
import { getShortcut, SHORTCUT_LIST_SEARCH } from "@/lib/shortcuts/registry";
import { useShortcut } from "@/lib/shortcuts/use-shortcut";

/** What a list page passes to `ListToolbar`'s `search`. */
export interface ListSearchShortcut {
	/** Attach to the search input (`search.inputRef`). */
	inputRef: RefObject<HTMLInputElement | null>;
	/** The hint to draw (`search.shortcut`); `undefined` until the platform is known. */
	shortcut: FilterSearchShortcut | undefined;
}

/**
 * Binds `/` to focus the list search while the calling component is mounted, and returns the ref to
 * put on the search input plus the hint that says so. Pass `{ enabled: false }` to stand the key
 * down (the hint goes with it).
 */
export function useListSearchShortcut(options: { enabled?: boolean } = {}): ListSearchShortcut {
	const enabled = options.enabled ?? true;
	const inputRef = useRef<HTMLInputElement | null>(null);
	useShortcut(
		SHORTCUT_LIST_SEARCH,
		() => {
			const input = inputRef.current;
			if (input === null) return;
			input.focus();
			input.select();
		},
		{ enabled },
	);
	const label = useShortcutLabel(SHORTCUT_LIST_SEARCH);
	const shortcut =
		enabled && label !== null
			? { hint: label, ariaKeyShortcuts: ariaKeyShortcuts(getShortcut(SHORTCUT_LIST_SEARCH).chord) }
			: undefined;
	return { inputRef, shortcut };
}
