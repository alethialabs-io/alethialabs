// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `useListSearchShortcut` (#7737): `/` focuses the list page's search through the registry row
// `list.search`, wired into `@repo/ui`'s `ListToolbar` exactly as a list page adopts it.
//
// What is asserted is what the user can tell: where the focus went, whether a `/` was typed into
// the field it came from, and whether the hint and `aria-keyshortcuts` are there. `fireEvent.keyDown`
// returns `false` exactly when something called `preventDefault`, so "the browser kept the key" is
// a real assertion here.

import { ListToolbar } from "@repo/ui/list-toolbar";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";

/** A list page's toolbar, adopting the shortcut the documented way. */
function Page({ enabled }: { enabled?: boolean }) {
	const [q, setQ] = useState("");
	const { inputRef, shortcut } = useListSearchShortcut({ enabled });
	return (
		<>
			<ListToolbar
				search={{ value: q, onChange: setQ, placeholder: "Search runners", inputRef, shortcut }}
			/>
			<input aria-label="Elsewhere" />
			<textarea aria-label="Notes" />
			<button type="button">Somewhere</button>
			<div role="dialog" aria-label="Sheet">
				<button type="button">In the sheet</button>
			</div>
		</>
	);
}

/** Presses `/` on `target` and returns whether the browser kept the key (no preventDefault). */
function pressSlash(target: Element = document.body): boolean {
	let kept = true;
	act(() => {
		kept = fireEvent.keyDown(target, { key: "/", code: "Slash" });
	});
	return kept;
}

describe("useListSearchShortcut", () => {
	it("`/` from the page focuses the list search and is not typed", () => {
		render(<Page />);
		const search = screen.getByRole("textbox", { name: "Search runners" });
		expect(pressSlash(screen.getByRole("button", { name: "Somewhere" }))).toBe(false);
		expect(search).toHaveFocus();
		expect(search).toHaveValue("");
	});

	it("`/` while typing in another field is left to the field", () => {
		render(<Page />);
		const search = screen.getByRole("textbox", { name: "Search runners" });
		for (const name of ["Elsewhere", "Notes"]) {
			const field = screen.getByRole("textbox", { name });
			field.focus();
			expect(pressSlash(field)).toBe(true);
			expect(field).toHaveFocus();
			expect(search).not.toHaveFocus();
		}
	});

	it("`/` inside a dialog is left to the dialog", () => {
		render(<Page />);
		const inside = screen.getByRole("button", { name: "In the sheet" });
		inside.focus();
		expect(pressSlash(inside)).toBe(true);
		expect(inside).toHaveFocus();
	});

	it("draws the hint and states the key once the binding is live", () => {
		const { container } = render(<Page />);
		const search = screen.getByRole("textbox", { name: "Search runners" });
		expect(search).toHaveAttribute("aria-keyshortcuts", "/");
		expect(container.querySelector('[data-slot="filter-search-hint"]')).toHaveTextContent("/");
	});

	it("disabled: no hint, and `/` is not answered", () => {
		const { container } = render(<Page enabled={false} />);
		const search = screen.getByRole("textbox", { name: "Search runners" });
		expect(search).not.toHaveAttribute("aria-keyshortcuts");
		expect(container.querySelector('[data-slot="filter-search-hint"]')).toBeNull();
		expect(pressSlash()).toBe(true);
		expect(search).not.toHaveFocus();
	});

	it("stops answering `/` once the page unmounts", () => {
		const { unmount } = render(<Page />);
		unmount();
		expect(pressSlash()).toBe(true);
	});
});
