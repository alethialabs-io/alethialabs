"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `useShortcut(id, handler)` — how a component answers a registered shortcut — and the single
// `keydown` listener behind it.
//
// One listener, on `document`, installed while at least one handler is mounted. For each key press
// it picks ONE winner among the mounted handlers whose chord matches (the narrowest scope, then the
// most recently mounted), and only then asks whether that winner may fire where the focus is. The
// order matters: a narrower binding that is not allowed in a field must not hand the key to a
// broader one that is.
//
// A key press that fires nothing is left completely alone — no `preventDefault` — so Tab,
// Shift+Tab and typing keep the browser's behaviour everywhere.

import { useEffect, useRef } from "react";
import {
	findShortcut,
	getShortcut,
	isEditableTarget,
	isInDialog,
	matchesChord,
	SCOPE_RANK,
	type ShortcutBinding,
} from "./registry";

/** What a component does when its shortcut fires. */
export type ShortcutHandler = (event: KeyboardEvent) => void;

/** One mounted `useShortcut` call. */
interface MountedShortcut {
	id: string;
	run: ShortcutHandler;
}

/** Mounted handlers, oldest first. */
const mounted: MountedShortcut[] = [];

/**
 * Routes one key press to at most one mounted handler. Skips a press something closer to the
 * focus already handled (`defaultPrevented`) and one that belongs to an input method composing
 * text.
 */
function dispatchShortcut(event: KeyboardEvent): void {
	if (event.defaultPrevented || event.isComposing) return;
	let winner: { binding: ShortcutBinding; entry: MountedShortcut } | null = null;
	for (const entry of mounted) {
		const binding = findShortcut(entry.id);
		if (!binding || !matchesChord(binding.chord, event)) continue;
		// `>=`, so that among equals the most recently mounted handler wins.
		if (!winner || SCOPE_RANK[binding.scope] >= SCOPE_RANK[winner.binding.scope])
			winner = { binding, entry };
	}
	if (!winner) return;
	if (isEditableTarget(event.target) && winner.binding.allowInInput !== true) return;
	if (isInDialog(event.target) && winner.binding.allowInDialog !== true) return;
	event.preventDefault();
	winner.entry.run(event);
}

/**
 * Runs `handler` when the shortcut registered as `id` is pressed, for as long as the calling
 * component is mounted and `enabled` is not `false`. The handler may change on every render; the
 * latest one is called. Throws for an id the registry does not hold.
 */
export function useShortcut(
	id: string,
	handler: ShortcutHandler,
	options: { enabled?: boolean } = {},
): void {
	const enabled = options.enabled ?? true;
	const latest = useRef(handler);
	useEffect(() => {
		latest.current = handler;
	});
	useEffect(() => {
		if (!enabled) return;
		getShortcut(id);
		const entry: MountedShortcut = { id, run: (event) => latest.current(event) };
		mounted.push(entry);
		if (mounted.length === 1) document.addEventListener("keydown", dispatchShortcut);
		return () => {
			const index = mounted.indexOf(entry);
			if (index !== -1) mounted.splice(index, 1);
			if (mounted.length === 0) document.removeEventListener("keydown", dispatchShortcut);
		};
	}, [id, enabled]);
}
