// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas' keyboard-shortcut hint rows, kept apart from the canvas component so the list is a
// pure function of (platform, mode) — testable without mounting React Flow.

/**
 * The shortcut hint rows, with OS-correct modifier glyphs (⌘ on macOS, `Ctrl` elsewhere).
 *
 * The key handlers themselves stay OS-agnostic (`metaKey || ctrlKey`) — only the labels differ.
 *
 * `canSave` is the create flow. On a live project there is no save shortcut to advertise: the
 * pending-changes bar is the only path changes take, so the row is dropped rather than left
 * promising a gesture that does nothing.
 */
export function buildShortcuts(
	isMac: boolean,
	canSave: boolean,
): { label: string; keys: string }[] {
	const mod = isMac ? "⌘" : "Ctrl";
	const j = isMac ? "" : "+"; // "⌘K" on macOS vs "Ctrl+K" elsewhere
	return [
		{ label: "Command palette", keys: `${mod}${j}K` },
		{ label: "Add component", keys: "A" },
		{ label: "Pan the canvas", keys: "Space-drag" },
		{ label: "Hand tool (pan)", keys: "H" },
		{ label: "Ask AI", keys: `${mod}${j}I` },
		{ label: "Open inspector", keys: "Enter" },
		{ label: "Duplicate selection", keys: `${mod}${j}D` },
		{ label: "Delete selection", keys: "Del" },
		{
			label: "Undo / Redo",
			keys: isMac ? "⌘Z / ⇧⌘Z" : "Ctrl+Z / Ctrl+Shift+Z",
		},
		{ label: "Switch environment", keys: isMac ? "⇧⇥" : "Shift+Tab" },
		...(canSave ? [{ label: "Save project", keys: `${mod}${j}S` }] : []),
		{ label: "Shortcuts", keys: "?" },
	];
}
