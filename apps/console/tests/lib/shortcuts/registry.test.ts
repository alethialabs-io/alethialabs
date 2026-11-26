// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shortcut registry's rules, as plain functions (#6758).
//
// The table is the one place a key binding is written down, so what it REFUSES is the contract:
// Tab is never bound, the shell only gets modifier chords, a bare key lives in the list and canvas
// scopes alone, and no two rows of one scope answer the same key press. Each refusal is exercised with a
// row that differs from an accepted one in exactly the property under test, so a rule that stopped
// being enforced fails here rather than passing on some unrelated difference.

import { describe, expect, it } from "vitest";
import {
	findShortcut,
	formatChord,
	getShortcut,
	isEditableTarget,
	isInDialog,
	isModifierChord,
	listShortcuts,
	matchesChord,
	registerShortcuts,
	SCOPE_RANK,
	SHORTCUT_ENVIRONMENT_NEXT,
	SHORTCUT_LIST_SEARCH,
	SHORTCUT_PALETTE_TOGGLE,
	shortcutProblem,
	type ChordEvent,
	type ShortcutBinding,
	type ShortcutScope,
} from "@/lib/shortcuts/registry";

/** Every scope the registry has. */
const SCOPES: ShortcutScope[] = ["global", "list", "canvas"];

/** A key press with no modifiers held, overridden per case. */
function press(over: Partial<ChordEvent>): ChordEvent {
	return {
		key: "",
		code: "",
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...over,
	};
}

/** A binding the rules accept, overridden per case. */
function binding(over: Partial<ShortcutBinding>): ShortcutBinding {
	return {
		id: "test.row",
		chord: { key: "j", mod: true },
		scope: "global",
		label: "Test",
		...over,
	};
}

describe("the shell's own bindings", () => {
	it("registers the palette and the environment switch", () => {
		expect(getShortcut(SHORTCUT_PALETTE_TOGGLE).scope).toBe("global");
		expect(getShortcut(SHORTCUT_ENVIRONMENT_NEXT).scope).toBe("global");
	});

	it("every global row is a modifier chord, and no row binds Tab", () => {
		const rows = listShortcuts();
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect(shortcutProblem(row)).toBeNull();
			expect(row.chord.key).not.toBe("tab");
			if (row.scope === "global") expect(isModifierChord(row.chord)).toBe(true);
		}
	});

	it("no registered row answers Tab or Shift+Tab", () => {
		for (const row of listShortcuts()) {
			expect(matchesChord(row.chord, press({ key: "Tab", code: "Tab" }))).toBe(false);
			expect(
				matchesChord(row.chord, press({ key: "Tab", code: "Tab", shiftKey: true })),
			).toBe(false);
		}
	});

	it("the environment switch is not allowed while typing; the palette is", () => {
		expect(getShortcut(SHORTCUT_ENVIRONMENT_NEXT).allowInInput).not.toBe(true);
		expect(getShortcut(SHORTCUT_PALETTE_TOGGLE).allowInInput).toBe(true);
	});
});

describe("shortcutProblem", () => {
	it("accepts a global modifier chord", () => {
		expect(shortcutProblem(binding({}))).toBeNull();
		expect(shortcutProblem(binding({ chord: { key: "e", alt: true } }))).toBeNull();
	});

	it("refuses Tab in every scope, with or without modifiers", () => {
		for (const scope of SCOPES) {
			expect(shortcutProblem(binding({ scope, chord: { key: "tab" } }))).toMatch(/Tab/);
			expect(shortcutProblem(binding({ scope, chord: { key: "tab", shift: true } }))).toMatch(
				/Tab/,
			);
			expect(shortcutProblem(binding({ scope, chord: { key: "tab", mod: true } }))).toMatch(
				/Tab/,
			);
			expect(shortcutProblem(binding({ scope, chord: { key: "x", code: "Tab", mod: true } }))).toMatch(
				/Tab/,
			);
		}
	});

	it("refuses a bare key in the global scope: a letter, Enter, Esc, and Shift+letter", () => {
		for (const chord of [
			{ key: "f" },
			{ key: "enter" },
			{ key: "escape" },
			{ key: "f", shift: true },
		]) {
			expect(shortcutProblem(binding({ scope: "global", chord }))).toMatch(/bare key/);
		}
	});

	it("allows the same bare keys in the canvas scope", () => {
		for (const chord of [{ key: "a" }, { key: "enter" }, { key: "escape" }, { key: "?" }]) {
			expect(shortcutProblem(binding({ scope: "canvas", chord }))).toBeNull();
		}
	});

	// #7737: the list page's `/` is a bare key, so it needs a scope that admits one — and the shell's
	// global scope must go on refusing exactly the same chord.
	it("allows a bare key in the list scope, and the global scope still refuses the same chord", () => {
		for (const chord of [{ key: "/" }, { key: "a" }, { key: "escape" }]) {
			expect(shortcutProblem(binding({ scope: "list", chord }))).toBeNull();
			expect(shortcutProblem(binding({ scope: "global", chord }))).toMatch(/bare key/);
		}
	});

	it("refuses allowInInput on a bare key in the list scope too", () => {
		expect(
			shortcutProblem(binding({ scope: "list", chord: { key: "/" }, allowInInput: true })),
		).toMatch(/modifier chord/);
	});

	it("ranks the list scope between the shell and the board", () => {
		expect(SCOPE_RANK.global).toBeLessThan(SCOPE_RANK.list);
		expect(SCOPE_RANK.list).toBeLessThan(SCOPE_RANK.canvas);
	});

	it("registers list.search as a bare `/` in the list scope, labelled for a shortcut list", () => {
		const row = getShortcut(SHORTCUT_LIST_SEARCH);
		expect(row.scope).toBe("list");
		expect(row.chord).toEqual({ key: "/" });
		expect(row.allowInInput).not.toBe(true);
		expect(row.label).toBe("Search this list");
		expect(listShortcuts("list").map((b) => b.id)).toContain(SHORTCUT_LIST_SEARCH);
		expect(matchesChord(row.chord, press({ key: "/", code: "Slash" }))).toBe(true);
		// Shift is not read: on many layouts `/` is a shifted key.
		expect(matchesChord(row.chord, press({ key: "/", shiftKey: true }))).toBe(true);
		expect(matchesChord(row.chord, press({ key: "/", ctrlKey: true }))).toBe(false);
	});

	it("refuses allowInInput on a bare key, and allows it on a modifier chord", () => {
		expect(
			shortcutProblem(binding({ scope: "canvas", chord: { key: "a" }, allowInInput: true })),
		).toMatch(/modifier chord/);
		expect(
			shortcutProblem(
				binding({ scope: "canvas", chord: { key: "a", mod: true }, allowInInput: true }),
			),
		).toBeNull();
	});

	it("refuses an upper-case key, which no lower-cased event key could equal", () => {
		expect(shortcutProblem(binding({ chord: { key: "K", mod: true } }))).toMatch(/lower-case/);
	});
});

describe("registerShortcuts", () => {
	it("adds a canvas-scoped bare key, and lists it under its scope only", () => {
		registerShortcuts([
			binding({ id: "t1.canvas.add", scope: "canvas", chord: { key: "a" }, label: "Add" }),
		]);
		expect(listShortcuts("canvas").map((b) => b.id)).toContain("t1.canvas.add");
		expect(listShortcuts("global").map((b) => b.id)).not.toContain("t1.canvas.add");
	});

	it("throws on a refused row", () => {
		expect(() =>
			registerShortcuts([binding({ id: "t2.bare", scope: "global", chord: { key: "f" } })]),
		).toThrow(/bare key/);
		expect(findShortcut("t2.bare")).toBeUndefined();
	});

	it("registers nothing from a call that throws part-way", () => {
		expect(() =>
			registerShortcuts([
				binding({ id: "t3.good", chord: { key: "1", mod: true } }),
				binding({ id: "t3.bad", chord: { key: "tab" } }),
			]),
		).toThrow();
		expect(findShortcut("t3.good")).toBeUndefined();
	});

	it("throws when another row of the same scope answers the same chord", () => {
		expect(() =>
			registerShortcuts([
				binding({ id: "t4.second-palette", chord: { key: "k", mod: true, shift: false } }),
			]),
		).toThrow(/same chord/);
	});

	it("reads an unstated Shift as either, and a shared code as the same key", () => {
		expect(() =>
			registerShortcuts([binding({ id: "t5.any-shift", chord: { key: "k", mod: true } })]),
		).toThrow(/same chord/);
		expect(() =>
			registerShortcuts([
				binding({ id: "t5.by-code", chord: { key: "é", code: "KeyE", alt: true } }),
			]),
		).toThrow(/same chord/);
	});

	it("does not treat a different modifier set as the same chord", () => {
		registerShortcuts([
			binding({ id: "t6.shifted", chord: { key: "k", mod: true, shift: true } }),
		]);
		expect(getShortcut("t6.shifted").chord.shift).toBe(true);
	});

	it("lets a narrower scope answer a chord the shell also answers", () => {
		registerShortcuts([
			binding({
				id: "t7.canvas.palette",
				scope: "canvas",
				chord: { key: "k", mod: true, shift: false },
			}),
		]);
		expect(getShortcut("t7.canvas.palette").scope).toBe("canvas");
	});

	it("replaces the row when an id is registered again", () => {
		registerShortcuts([binding({ id: "t8.row", chord: { key: "2", mod: true }, label: "One" })]);
		registerShortcuts([binding({ id: "t8.row", chord: { key: "3", mod: true }, label: "Two" })]);
		expect(getShortcut("t8.row").label).toBe("Two");
		expect(listShortcuts().filter((b) => b.id === "t8.row")).toHaveLength(1);
	});

	it("getShortcut throws for an id nobody registered; findShortcut returns undefined", () => {
		expect(() => getShortcut("t9.nope")).toThrow(/no shortcut is registered/);
		expect(findShortcut("t9.nope")).toBeUndefined();
	});
});

describe("matchesChord", () => {
	const palette = getShortcut(SHORTCUT_PALETTE_TOGGLE).chord;
	const nextEnv = getShortcut(SHORTCUT_ENVIRONMENT_NEXT).chord;

	it("the palette is ⌘K or Ctrl+K, in either letter case, and nothing else", () => {
		expect(matchesChord(palette, press({ key: "k", metaKey: true }))).toBe(true);
		expect(matchesChord(palette, press({ key: "K", ctrlKey: true }))).toBe(true);
		expect(matchesChord(palette, press({ key: "k" }))).toBe(false);
		expect(matchesChord(palette, press({ key: "k", metaKey: true, shiftKey: true }))).toBe(false);
		expect(matchesChord(palette, press({ key: "k", metaKey: true, altKey: true }))).toBe(false);
		expect(matchesChord(palette, press({ key: "f" }))).toBe(false);
	});

	it("the environment switch is ⌥E, including where ⌥ rewrites the key to a dead key", () => {
		expect(matchesChord(nextEnv, press({ key: "e", code: "KeyE", altKey: true }))).toBe(true);
		expect(matchesChord(nextEnv, press({ key: "Dead", code: "KeyE", altKey: true }))).toBe(true);
		expect(matchesChord(nextEnv, press({ key: "e", code: "KeyE" }))).toBe(false);
		expect(
			matchesChord(nextEnv, press({ key: "e", code: "KeyE", altKey: true, shiftKey: true })),
		).toBe(false);
	});

	it("AltGr, which reports Ctrl and Alt together, is not the Alt chord", () => {
		expect(
			matchesChord(nextEnv, press({ key: "€", code: "KeyE", altKey: true, ctrlKey: true })),
		).toBe(false);
	});

	it("a chord with no stated Shift matches with Shift up or down", () => {
		const help = { key: "?" };
		expect(matchesChord(help, press({ key: "?", shiftKey: true }))).toBe(true);
		expect(matchesChord(help, press({ key: "?" }))).toBe(true);
	});
});

describe("isEditableTarget and isInDialog", () => {
	it("reads input, textarea, select and contenteditable — and a node inside one — as typing", () => {
		for (const tag of ["input", "textarea", "select"]) {
			expect(isEditableTarget(document.createElement(tag))).toBe(true);
		}
		const host = document.createElement("div");
		host.setAttribute("contenteditable", "true");
		const inner = document.createElement("span");
		host.append(inner);
		expect(isEditableTarget(host)).toBe(true);
		expect(isEditableTarget(inner)).toBe(true);
	});

	it("does not read a button, a plain div, contenteditable=false or no target as typing", () => {
		expect(isEditableTarget(document.createElement("button"))).toBe(false);
		expect(isEditableTarget(document.createElement("div"))).toBe(false);
		const off = document.createElement("div");
		off.setAttribute("contenteditable", "false");
		expect(isEditableTarget(off)).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
		expect(isEditableTarget(document)).toBe(false);
	});

	it("reads a target inside a dialog, alert dialog or menu as in a dialog, and the page as not", () => {
		for (const role of ["dialog", "alertdialog", "menu"]) {
			const layer = document.createElement("div");
			layer.setAttribute("role", role);
			const button = document.createElement("button");
			layer.append(button);
			expect(isInDialog(button)).toBe(true);
		}
		expect(isInDialog(document.createElement("button"))).toBe(false);
		expect(isInDialog(null)).toBe(false);
	});
});

describe("formatChord", () => {
	it("uses glyphs on macOS and words joined by + elsewhere", () => {
		expect(formatChord({ key: "k", mod: true }, true)).toBe("⌘K");
		expect(formatChord({ key: "k", mod: true }, false)).toBe("Ctrl+K");
		expect(formatChord({ key: "e", alt: true }, true)).toBe("⌥E");
		expect(formatChord({ key: "e", alt: true }, false)).toBe("Alt+E");
		expect(formatChord({ key: "z", mod: true, shift: true }, true)).toBe("⇧⌘Z");
		expect(formatChord({ key: "z", mod: true, shift: true }, false)).toBe("Ctrl+Shift+Z");
	});

	it("names the keys that have no printable character", () => {
		expect(formatChord({ key: "escape" }, true)).toBe("Esc");
		expect(formatChord({ key: " " }, false)).toBe("Space");
		expect(formatChord({ key: "enter" }, false)).toBe("Enter");
		expect(formatChord({ key: "?" }, true)).toBe("?");
	});
});
