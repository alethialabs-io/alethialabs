// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's key map (#6832), as rows of the console's one shortcut registry
// (`lib/shortcuts/registry.ts`), in the `canvas` scope.
//
// This file is the table and nothing else: no listener, no React. `design-project-canvas.tsx`
// answers each row with `useShortcut`, a toolbar button shows its row's chord in its tooltip, and
// the `?` sheet (`../shortcuts.ts`) lists the rows the registry holds. A key the board binds and
// the key a person is told about are therefore the same row.
//
// What the registry enforces for every row here: a bare key never fires while the focus is in a
// field, and nothing fires from inside a dialog or a menu unless the row says so.
//
// The keys that act on what is focused or selected ON the board — Enter, Delete, Backspace, `C` —
// are the board's own rows (`../nodes/board-shortcuts.ts`, #6835). They are not registered again
// here: the registry refuses two rows for one chord in one scope. The host answers the board's
// Delete and Backspace rows for a selection of cards, the board answers them for a connection.

import { registerShortcuts, type ShortcutBinding } from "@/lib/shortcuts/registry";

/** Open or close the board's command palette. Outranks the shell's palette while the board is mounted. */
export const SHORTCUT_CANVAS_PALETTE = "canvas.palette";
/** Open the add picker. */
export const SHORTCUT_CANVAS_ADD = "canvas.add";
/** The select tool: a drag on the board draws a selection. */
export const SHORTCUT_CANVAS_SELECT = "canvas.tool.select";
/** The hand tool: a drag on the board pans it. */
export const SHORTCUT_CANVAS_HAND = "canvas.tool.hand";
/** Undo the last step. */
export const SHORTCUT_CANVAS_UNDO = "canvas.undo";
/** Redo the step last undone. */
export const SHORTCUT_CANVAS_REDO = "canvas.redo";
/** Duplicate the selected cards. */
export const SHORTCUT_CANVAS_DUPLICATE = "canvas.duplicate";
/** Close the inspector. */
export const SHORTCUT_CANVAS_CLOSE = "canvas.close";
/** Save the design without deploying it. */
export const SHORTCUT_CANVAS_SAVE = "canvas.save";
/** Open the assistant on this project. */
export const SHORTCUT_CANVAS_ASSISTANT = "canvas.assistant";
/** Fit the whole design in view. */
export const SHORTCUT_CANVAS_FIT = "canvas.fit";
/** Lay the cards out again. */
export const SHORTCUT_CANVAS_TIDY = "canvas.tidy";
/** Open the list of keyboard shortcuts. */
export const SHORTCUT_CANVAS_SHORTCUTS = "canvas.shortcuts";

/** The rows this file registers, in the order the shortcut sheet lists them. */
export const CANVAS_KEYS: readonly ShortcutBinding[] = [
	{
		id: SHORTCUT_CANVAS_PALETTE,
		chord: { key: "k", mod: true, shift: false },
		scope: "canvas",
		label: "Command palette",
		// The palette's search field has the focus while it is open, inside its own dialog, and the
		// same chord closes it again.
		allowInInput: true,
		allowInDialog: true,
	},
	{
		id: SHORTCUT_CANVAS_ADD,
		chord: { key: "a", shift: false },
		scope: "canvas",
		label: "Add component",
	},
	{
		id: SHORTCUT_CANVAS_SELECT,
		chord: { key: "v", shift: false },
		scope: "canvas",
		label: "Select tool",
	},
	{
		id: SHORTCUT_CANVAS_HAND,
		chord: { key: "h", shift: false },
		scope: "canvas",
		label: "Hand tool (pan)",
	},
	// Undo and redo share one label so the sheet lists them as one row with both chords.
	// Both fire with the focus in a menu or a dialog: "Remove" in a card's context menu leaves the
	// focus on the menu while it closes, and the undo that follows it must still be the board's.
	// Neither fires in a field, where the chord is the field's own.
	{
		id: SHORTCUT_CANVAS_UNDO,
		chord: { key: "z", mod: true, shift: false },
		scope: "canvas",
		label: "Undo / Redo",
		allowInDialog: true,
	},
	{
		id: SHORTCUT_CANVAS_REDO,
		chord: { key: "z", mod: true, shift: true },
		scope: "canvas",
		label: "Undo / Redo",
		allowInDialog: true,
	},
	{
		id: SHORTCUT_CANVAS_DUPLICATE,
		chord: { key: "d", mod: true, shift: false },
		scope: "canvas",
		label: "Duplicate selection",
	},
	{
		id: SHORTCUT_CANVAS_CLOSE,
		chord: { key: "escape", shift: false },
		scope: "canvas",
		label: "Close the inspector",
	},
	{
		id: SHORTCUT_CANVAS_SAVE,
		chord: { key: "s", mod: true, shift: false },
		scope: "canvas",
		label: "Save the design",
		// Taken in a field too: the browser's own "save this page" must not open over the board.
		allowInInput: true,
	},
	{
		id: SHORTCUT_CANVAS_ASSISTANT,
		chord: { key: "i", mod: true, shift: false },
		scope: "canvas",
		label: "Ask AI",
	},
	{
		id: SHORTCUT_CANVAS_FIT,
		// Shift+1 types "!" or another symbol, never "1", so it is the physical key that identifies
		// the chord; `key` is what a shortcut list prints.
		chord: { key: "1", code: "Digit1", shift: true },
		scope: "canvas",
		label: "Fit view",
	},
	{
		id: SHORTCUT_CANVAS_TIDY,
		chord: { key: "l", shift: true },
		scope: "canvas",
		label: "Tidy layout",
	},
	{
		id: SHORTCUT_CANVAS_SHORTCUTS,
		// Shift is not read: "?" is Shift+/ on some layouts and a key of its own on others.
		chord: { key: "?" },
		scope: "canvas",
		label: "Keyboard shortcuts",
	},
];

registerShortcuts(CANVAS_KEYS);
