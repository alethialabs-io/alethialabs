// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `useShortcut` and the one keydown listener behind it (#6758).
//
// What is asserted is what the user can tell: whether the handler ran, and whether the browser
// kept the key. `fireEvent.keyDown` returns `false` exactly when something called
// `preventDefault`, so "the browser still does its own thing with this key" is a real assertion
// here and not an inference from the handler staying quiet.
//
// The four typing surfaces — input, textarea, select, contenteditable — are each driven
// separately, for a bare key, for a modifier chord that is not marked, and for one that is.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	registerShortcuts,
	SHORTCUT_ENVIRONMENT_NEXT,
	SHORTCUT_PALETTE_TOGGLE,
} from "@/lib/shortcuts/registry";
import { useShortcut, type ShortcutHandler } from "@/lib/shortcuts/use-shortcut";

const CANVAS_ADD = "test.canvas.add";
const CANVAS_PALETTE = "test.canvas.palette";
const GLOBAL_UNMARKED = "test.global.unmarked";
const GLOBAL_MARKED = "test.global.marked";

registerShortcuts([
	{ id: CANVAS_ADD, chord: { key: "a" }, scope: "canvas", label: "Add" },
	{
		id: CANVAS_PALETTE,
		chord: { key: "k", mod: true, shift: false },
		scope: "canvas",
		label: "Canvas palette",
	},
	{ id: GLOBAL_UNMARKED, chord: { key: "j", mod: true }, scope: "global", label: "Unmarked" },
	{
		id: GLOBAL_MARKED,
		chord: { key: "u", mod: true },
		scope: "global",
		label: "Marked",
		allowInInput: true,
	},
]);

/** Mounts one `useShortcut` call. */
function Probe({
	id,
	onFire,
	enabled,
}: {
	id: string;
	onFire: ShortcutHandler;
	enabled?: boolean;
}) {
	useShortcut(id, onFire, { enabled });
	return null;
}

/** The surfaces a key can come from: the page, the four typing surfaces, and a dialog. */
function Surfaces() {
	return (
		<div>
			<button type="button" data-testid="page">
				page
			</button>
			<input data-testid="input" />
			<textarea data-testid="textarea" />
			<select data-testid="select">
				<option>one</option>
			</select>
			<div data-testid="contenteditable" contentEditable suppressContentEditableWarning>
				<span data-testid="contenteditable-child">text</span>
			</div>
			<div role="dialog" aria-label="A dialog">
				<button type="button" data-testid="in-dialog">
					inside
				</button>
			</div>
		</div>
	);
}

const TYPING_SURFACES = ["input", "textarea", "select", "contenteditable", "contenteditable-child"];

describe("focus traversal is the browser's", () => {
	it("Tab and Shift+Tab are never taken, with every shell shortcut mounted", () => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={SHORTCUT_PALETTE_TOGGLE} onFire={fired} />
				<Probe id={SHORTCUT_ENVIRONMENT_NEXT} onFire={fired} />
				<Probe id={CANVAS_ADD} onFire={fired} />
				<Surfaces />
			</>,
		);
		for (const surface of ["page", "in-dialog", ...TYPING_SURFACES]) {
			const el = getByTestId(surface);
			expect(fireEvent.keyDown(el, { key: "Tab", code: "Tab", shiftKey: true })).toBe(true);
			expect(fireEvent.keyDown(el, { key: "Tab", code: "Tab" })).toBe(true);
		}
		expect(fireEvent.keyDown(document.body, { key: "Tab", code: "Tab", shiftKey: true })).toBe(
			true,
		);
		expect(fired).not.toHaveBeenCalled();
	});
});

describe("a bare key (canvas scope)", () => {
	it("fires from the page and takes the key", () => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={CANVAS_ADD} onFire={fired} />
				<Surfaces />
			</>,
		);
		expect(fireEvent.keyDown(getByTestId("page"), { key: "a" })).toBe(false);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it.each(TYPING_SURFACES)("does not fire in %s, and the key is left to it", (surface) => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={CANVAS_ADD} onFire={fired} />
				<Surfaces />
			</>,
		);
		expect(fireEvent.keyDown(getByTestId(surface), { key: "a" })).toBe(true);
		expect(fired).not.toHaveBeenCalled();
	});
});

describe("a modifier chord", () => {
	it.each(TYPING_SURFACES)("that is not marked does not fire in %s", (surface) => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={fired} />
				<Surfaces />
			</>,
		);
		expect(fireEvent.keyDown(getByTestId(surface), { key: "j", metaKey: true })).toBe(true);
		expect(fired).not.toHaveBeenCalled();
		// The same chord from the page does fire, so the silence above is the field's doing.
		expect(fireEvent.keyDown(getByTestId("page"), { key: "j", metaKey: true })).toBe(false);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it.each(TYPING_SURFACES)("that is marked allowInInput fires in %s", (surface) => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={GLOBAL_MARKED} onFire={fired} />
				<Surfaces />
			</>,
		);
		expect(fireEvent.keyDown(getByTestId(surface), { key: "u", ctrlKey: true })).toBe(false);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it.each(TYPING_SURFACES)("the environment switch does not fire in %s", (surface) => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={SHORTCUT_ENVIRONMENT_NEXT} onFire={fired} />
				<Surfaces />
			</>,
		);
		expect(
			fireEvent.keyDown(getByTestId(surface), { key: "Dead", code: "KeyE", altKey: true }),
		).toBe(true);
		expect(fired).not.toHaveBeenCalled();
	});
});

describe("inside a dialog", () => {
	it("a shortcut not marked allowInDialog does not fire; one that is does", () => {
		const unmarked = vi.fn();
		const palette = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={unmarked} />
				<Probe id={SHORTCUT_PALETTE_TOGGLE} onFire={palette} />
				<Surfaces />
			</>,
		);
		const inside = getByTestId("in-dialog");
		expect(fireEvent.keyDown(inside, { key: "j", metaKey: true })).toBe(true);
		expect(unmarked).not.toHaveBeenCalled();
		expect(fireEvent.keyDown(inside, { key: "k", metaKey: true })).toBe(false);
		expect(palette).toHaveBeenCalledTimes(1);
	});
});

describe("two scopes answering one chord", () => {
	it("the narrower scope wins while it is mounted, and the shell gets the chord back after", () => {
		const shell = vi.fn();
		const canvas = vi.fn();
		const { getByTestId, rerender } = render(
			<>
				<Probe id={CANVAS_PALETTE} onFire={canvas} />
				<Probe id={SHORTCUT_PALETTE_TOGGLE} onFire={shell} />
				<Surfaces />
			</>,
		);
		fireEvent.keyDown(getByTestId("page"), { key: "k", metaKey: true });
		expect(canvas).toHaveBeenCalledTimes(1);
		expect(shell).not.toHaveBeenCalled();

		rerender(
			<>
				<Probe id={SHORTCUT_PALETTE_TOGGLE} onFire={shell} />
				<Surfaces />
			</>,
		);
		fireEvent.keyDown(getByTestId("page"), { key: "k", metaKey: true });
		expect(canvas).toHaveBeenCalledTimes(1);
		expect(shell).toHaveBeenCalledTimes(1);
	});

	it("a winner that may not fire here does not hand the key to the broader scope", () => {
		const shell = vi.fn();
		const canvas = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={CANVAS_PALETTE} onFire={canvas} />
				<Probe id={SHORTCUT_PALETTE_TOGGLE} onFire={shell} />
				<Surfaces />
			</>,
		);
		// The canvas row is not marked for fields; the shell row is. The canvas row still owns the
		// chord, so nothing fires.
		expect(fireEvent.keyDown(getByTestId("input"), { key: "k", metaKey: true })).toBe(true);
		expect(canvas).not.toHaveBeenCalled();
		expect(shell).not.toHaveBeenCalled();
	});
});

describe("mounting", () => {
	it("enabled: false binds nothing, and flipping it binds", () => {
		const fired = vi.fn();
		const { getByTestId, rerender } = render(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={fired} enabled={false} />
				<Surfaces />
			</>,
		);
		expect(fireEvent.keyDown(getByTestId("page"), { key: "j", metaKey: true })).toBe(true);
		expect(fired).not.toHaveBeenCalled();
		rerender(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={fired} enabled />
				<Surfaces />
			</>,
		);
		expect(fireEvent.keyDown(getByTestId("page"), { key: "j", metaKey: true })).toBe(false);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it("calls the handler from the latest render", () => {
		const first = vi.fn();
		const second = vi.fn();
		const { getByTestId, rerender } = render(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={first} />
				<Surfaces />
			</>,
		);
		rerender(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={second} />
				<Surfaces />
			</>,
		);
		fireEvent.keyDown(getByTestId("page"), { key: "j", metaKey: true });
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("after the last handler unmounts, no key is taken", () => {
		const fired = vi.fn();
		const { unmount } = render(<Probe id={GLOBAL_UNMARKED} onFire={fired} />);
		unmount();
		expect(fireEvent.keyDown(document.body, { key: "j", metaKey: true })).toBe(true);
		expect(fired).not.toHaveBeenCalled();
	});

	it("leaves alone a key an element already handled, and one an input method is composing", () => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={fired} />
				<Surfaces />
			</>,
		);
		const page = getByTestId("page");
		const claim = (e: Event) => e.preventDefault();
		page.addEventListener("keydown", claim);
		fireEvent.keyDown(page, { key: "j", metaKey: true });
		page.removeEventListener("keydown", claim);
		expect(fired).not.toHaveBeenCalled();

		expect(fireEvent.keyDown(page, { key: "j", metaKey: true, isComposing: true })).toBe(true);
		expect(fired).not.toHaveBeenCalled();
	});

	it("passes the keyboard event to the handler", () => {
		const fired = vi.fn();
		const { getByTestId } = render(
			<>
				<Probe id={GLOBAL_UNMARKED} onFire={fired} />
				<Surfaces />
			</>,
		);
		fireEvent.keyDown(getByTestId("page"), { key: "j", metaKey: true });
		expect(fired.mock.calls[0]?.[0]).toBeInstanceOf(KeyboardEvent);
	});
});
