// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's own keys, as rows of the console's shortcut registry (#6835).
//
// These are the keys that act on what is focused or selected ON the board — a card or a
// connection. They are registered in the `canvas` scope, where a bare key is allowed, and the board
// answers each one through `useShortcut`, so there is no second key listener and a shortcut list
// rendered from the registry shows them.
//
// Moving a card with the arrow keys is not here: it is React Flow's own node handler, which only
// fires on a focused card, and binding the arrows page-wide would take scrolling from everything
// else on the page.

import { registerShortcuts } from "@/lib/shortcuts/registry";

/** Open the inspector on the focused card, or on the service a focused connection starts from. */
export const SHORTCUT_BOARD_OPEN = "canvas.board.open";
/** Remove the selected connection (Delete). */
export const SHORTCUT_BOARD_REMOVE = "canvas.board.remove";
/** Remove the selected connection (Backspace): the same action on the key a laptop has. */
export const SHORTCUT_BOARD_REMOVE_BACKSPACE = "canvas.board.remove.backspace";
/** Connect the selected service to another card, from a menu. */
export const SHORTCUT_BOARD_CONNECT = "canvas.board.connect";

registerShortcuts([
	{
		id: SHORTCUT_BOARD_OPEN,
		chord: { key: "enter", shift: false },
		scope: "canvas",
		label: "Open the focused card in the inspector",
	},
	{
		id: SHORTCUT_BOARD_REMOVE,
		chord: { key: "delete", shift: false },
		scope: "canvas",
		label: "Remove the selected connection",
	},
	{
		id: SHORTCUT_BOARD_REMOVE_BACKSPACE,
		chord: { key: "backspace", shift: false },
		scope: "canvas",
		label: "Remove the selected connection",
	},
	{
		id: SHORTCUT_BOARD_CONNECT,
		chord: { key: "c", shift: false },
		scope: "canvas",
		label: "Connect the selected service",
	},
]);
