// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's shortcut sheet is READ from the shortcut registry (#6832).
//
// It used to be a list typed beside the handlers, and it drifted: it went on advertising Shift+Tab
// for the environment switch after that key had been given back to the browser, and it advertised
// no save key on a board whose Save button's tooltip named one. A list generated from the rows the
// dispatcher matches cannot name a key the board does not bind — so what is asserted here is the
// correspondence, plus the rows the release gate's browser test looks for by name.

import { describe, expect, it } from "vitest";
import { buildShortcuts, shortcutRows } from "@/components/design-project/canvas/shortcuts";
import {
	SHORTCUT_BOARD_OPEN,
	SHORTCUT_BOARD_REMOVE,
	SHORTCUT_BOARD_REMOVE_BACKSPACE,
} from "@/components/design-project/canvas/nodes/board-shortcuts";
import { CANVAS_KEYS } from "@/components/design-project/canvas/toolbar/canvas-keys";
import {
	formatChord,
	getShortcut,
	listShortcuts,
	registerShortcuts,
	SHORTCUT_ENVIRONMENT_NEXT,
} from "@/lib/shortcuts/registry";

/** The sheet's row for a label, or undefined. */
function row(label: string, isMac = true) {
	return buildShortcuts(isMac).find((r) => r.label === label);
}

describe("the board's shortcut sheet", () => {
	it("lists every key registered in the canvas scope, with the chord the dispatcher matches", () => {
		const sheet = buildShortcuts(true);
		const missing = listShortcuts("canvas").filter((binding) => {
			const line = sheet.find((r) => r.label === binding.label);
			return !line || !line.keys.split(" / ").includes(formatChord(binding.chord, true));
		});
		expect(missing.map((binding) => binding.id)).toEqual([]);
	});

	it("lists a key another file registers in the canvas scope, without being told about it", () => {
		registerShortcuts([
			{
				id: "canvas.test.only",
				chord: { key: "j", shift: false },
				scope: "canvas",
				label: "A key registered by a test",
			},
		]);
		expect(row("A key registered by a test")?.keys).toBe("J");
	});

	it("names the environment switch by the key that switches it, not Shift+Tab", () => {
		const next = getShortcut(SHORTCUT_ENVIRONMENT_NEXT);
		expect(row(next.label)?.keys).toBe("⌥E");
		expect(row(next.label, false)?.keys).toBe("Alt+E");
		const tabbed = [...buildShortcuts(true), ...buildShortcuts(false)].filter((r) =>
			/tab|⇥/i.test(r.keys),
		);
		expect(tabbed).toEqual([]);
	});

	it("shows undo and redo as one line, and Delete with Backspace as one line", () => {
		expect(row("Undo / Redo")?.keys).toBe("⌘Z / ⇧⌘Z");
		expect(row("Undo / Redo", false)?.keys).toBe("Ctrl+Z / Ctrl+Shift+Z");
		expect(getShortcut(SHORTCUT_BOARD_REMOVE).label).toBe(
			getShortcut(SHORTCUT_BOARD_REMOVE_BACKSPACE).label,
		);
		expect(row(getShortcut(SHORTCUT_BOARD_REMOVE).label)?.keys).toBe("Del / Backspace");
	});

	it("keeps the rows the board's browser test finds by name, and promises no project save", () => {
		const labels = buildShortcuts(true).map((r) => r.label);
		for (const label of ["Command palette", "Add component", "Duplicate selection", "Undo / Redo"]) {
			expect(labels).toContain(label);
		}
		expect(labels).not.toContain("Save project");
	});

	it("uses the platform's modifier glyphs", () => {
		expect(row("Command palette")?.keys).toBe("⌘K");
		expect(row("Command palette", false)?.keys).toBe("Ctrl+K");
		expect(row("Fit view")?.keys).toBe("⇧1");
	});

	it("says how to pan, which is React Flow's gesture and not a registry row", () => {
		expect(row("Pan the canvas")?.keys).toBe("Space-drag");
		expect(listShortcuts("canvas").some((binding) => binding.chord.key === " ")).toBe(false);
	});
});

describe("shortcutRows", () => {
	it("joins the chords of rows that share a label, once each, in the order given", () => {
		const rows = shortcutRows(
			[
				{ id: "a", chord: { key: "delete" }, scope: "canvas", label: "Remove" },
				{ id: "b", chord: { key: "x" }, scope: "canvas", label: "Cut" },
				{ id: "c", chord: { key: "backspace" }, scope: "canvas", label: "Remove" },
				{ id: "d", chord: { key: "delete" }, scope: "canvas", label: "Remove" },
			],
			true,
		);
		expect(rows).toEqual([
			{ label: "Remove", keys: "Del / Backspace" },
			{ label: "Cut", keys: "X" },
		]);
	});
});

describe("the board's key table", () => {
	it("registers no second row on a chord the board itself registers", () => {
		// Enter, Delete and Backspace are the board's rows; the host answers two of them and adds none.
		const boardIds = [SHORTCUT_BOARD_OPEN, SHORTCUT_BOARD_REMOVE, SHORTCUT_BOARD_REMOVE_BACKSPACE];
		const boardKeys = boardIds.map((id) => getShortcut(id).chord.key);
		expect(CANVAS_KEYS.filter((binding) => boardKeys.includes(binding.chord.key))).toEqual([]);
		// One name for what Delete does, whichever of the two answers it.
		expect(getShortcut(SHORTCUT_BOARD_REMOVE).label).toBe("Remove the selection");
	});

	it("registers every row in the canvas scope", () => {
		expect(CANVAS_KEYS.filter((binding) => binding.scope !== "canvas")).toEqual([]);
		const unregistered = CANVAS_KEYS.filter((binding) => getShortcut(binding.id) !== binding);
		expect(unregistered.map((binding) => binding.id)).toEqual([]);
	});

	it("lets nothing but the palette and the save chord fire while typing in a field", () => {
		const inFields = CANVAS_KEYS.filter((binding) => binding.allowInInput === true).map(
			(binding) => binding.label,
		);
		expect(inFields).toEqual(["Command palette", "Save the design"]);
	});
});
