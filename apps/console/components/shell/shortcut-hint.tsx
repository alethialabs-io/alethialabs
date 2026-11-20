"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How the shell SHOWS a keyboard shortcut. Every key hint in the shell is rendered from the
// shortcut registry (`lib/shortcuts/registry.ts`) through this file, so a hint and the chord the
// listener answers are one row read twice. The Find box once showed `F` for months after the bare
// F shortcut had been removed, because the hint was a string typed beside the control.
//
// `tests/components/shell/shortcut-hints.test.tsx` holds this: it renders the hinted controls and
// compares them with the registry, and it reads the shell's sources for a chord typed by hand.

import { useHydrated } from "@repo/ui/use-hydrated";
import { cn } from "@repo/ui/utils";
import { formatChord, getShortcut, type ShortcutChord } from "@/lib/shortcuts/registry";

/** Whether this browser is on an Apple platform, where the modifiers are drawn as glyphs. */
function isApplePlatform(): boolean {
	return typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);
}

/** The key of a chord as `aria-keyshortcuts` spells it: a named key as it is, a letter upper-cased. */
function ariaKey(chord: ShortcutChord): string {
	if (chord.key === " ") return "Space";
	return chord.key.length === 1
		? chord.key.toUpperCase()
		: `${chord.key.charAt(0).toUpperCase()}${chord.key.slice(1)}`;
}

/**
 * A chord as the `aria-keyshortcuts` attribute states it. A `mod` chord is ⌘ on macOS and Ctrl
 * elsewhere, and the attribute may list alternatives, so both are named.
 */
export function ariaKeyShortcuts(chord: ShortcutChord): string {
	const rest = `${chord.alt ? "Alt+" : ""}${chord.shift ? "Shift+" : ""}${ariaKey(chord)}`;
	return chord.mod ? `Meta+${rest} Control+${rest}` : rest;
}

/**
 * The registered shortcut `id` as this platform shows it (`⌘K`, `Ctrl+K`), or `null` on the server
 * render and the render that hydrates it: the server cannot know the platform, and showing one
 * platform's keys to the other would be a wrong instruction. Throws for an id the registry does
 * not hold.
 */
export function useShortcutLabel(id: string): string | null {
	const hydrated = useHydrated();
	const { chord } = getShortcut(id);
	return hydrated ? formatChord(chord, isApplePlatform()) : null;
}

/**
 * The key hint for the registered shortcut `id`: a small `<kbd>`. It renders nothing until the
 * platform is known. It is hidden from the accessibility tree: the control it sits in states the
 * same chord with `aria-keyshortcuts` ({@link ariaKeyShortcuts}), which is where a screen reader
 * reads a shortcut from.
 */
export function ShortcutHint({ id, className }: { id: string; className?: string }) {
	const label = useShortcutLabel(id);
	if (label === null) return null;
	return (
		<kbd
			aria-hidden
			data-slot="shortcut-hint"
			data-shortcut={id}
			className={cn(
				"shrink-0 rounded border px-1.5 font-mono text-ui-2xs text-muted-foreground",
				className,
			)}
		>
			{label}
		</kbd>
	);
}
