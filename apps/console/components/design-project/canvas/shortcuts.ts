// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the board's `?` sheet lists (#6832).
//
// The sheet is READ from the console's shortcut registry (`lib/shortcuts/registry.ts`): every row
// registered in the `canvas` scope, whichever file registered it, plus the shell's "next
// environment" row. There is no second list here to keep in step with the handlers, which is how
// the sheet came to advertise Shift+Tab for the environment switch after that key had been given
// back to the browser.
//
// The one line that is not a registry row is the pan gesture. Holding Space to pan is React Flow's
// own (`panActivationKeyCode`); the board does not bind it, so there is no row to read.

import {
	findShortcut,
	formatChord,
	listShortcuts,
	SHORTCUT_ENVIRONMENT_NEXT,
	type ShortcutBinding,
} from "@/lib/shortcuts/registry";
// Imported for its registration: the board's own rows must be in the registry before it is read.
import "./toolbar/canvas-keys";

/** One line of the shortcut sheet: what it does, and the keys that do it. */
export interface ShortcutRow {
	label: string;
	keys: string;
}

/** The pan gesture, which React Flow handles itself and the registry therefore does not hold. */
const PAN_GESTURE: ShortcutRow = { label: "Pan the canvas", keys: "Space-drag" };

/**
 * Registry rows as sheet lines, in the order given. Rows with the same label are one line whose
 * keys are joined with " / " — "Undo / Redo" is two chords, and "Remove the selection" is Delete or
 * Backspace.
 */
export function shortcutRows(bindings: readonly ShortcutBinding[], isMac: boolean): ShortcutRow[] {
	const rows: { label: string; keys: string[] }[] = [];
	for (const binding of bindings) {
		const keys = formatChord(binding.chord, isMac);
		const existing = rows.find((row) => row.label === binding.label);
		if (!existing) rows.push({ label: binding.label, keys: [keys] });
		else if (!existing.keys.includes(keys)) existing.keys.push(keys);
	}
	return rows.map((row) => ({ label: row.label, keys: row.keys.join(" / ") }));
}

/**
 * The board's shortcut sheet, with the platform's modifier glyphs (⌘ on macOS, `Ctrl` elsewhere):
 * every `canvas` row in the registry, then the shell's environment switch, then the pan gesture.
 */
export function buildShortcuts(isMac: boolean): ShortcutRow[] {
	const next = findShortcut(SHORTCUT_ENVIRONMENT_NEXT);
	return [
		...shortcutRows([...listShortcuts("canvas"), ...(next ? [next] : [])], isMac),
		PAN_GESTURE,
	];
}
