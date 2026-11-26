// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the FilterSearch input: controlled value round-trip, the placeholder-as-accessible-name
// fallback, Esc to clear, and the opt-in `/` shortcut (#7737) — which must not fire from a field the
// user is typing in, and must let go of the page when the search unmounts.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterSearch, isTypingTarget } from "../src/filter-search";

/** Stateful harness so the controlled input actually accepts typing. */
function Harness({
	onChange,
	initial = "",
	slashToFocus,
}: {
	onChange: (v: string) => void;
	initial?: string;
	slashToFocus?: boolean;
}) {
	const [value, setValue] = useState(initial);
	return (
		<FilterSearch
			value={value}
			onChange={(v) => {
				setValue(v);
				onChange(v);
			}}
			placeholder="Filter by project…"
			slashToFocus={slashToFocus}
		/>
	);
}

describe("FilterSearch", () => {
	it("uses the placeholder as the accessible name by default", () => {
		render(<FilterSearch value="" onChange={() => {}} placeholder="Filter by project…" />);
		expect(screen.getByLabelText("Filter by project…")).toBeInTheDocument();
	});

	it("prefers an explicit ariaLabel", () => {
		render(
			<FilterSearch
				value=""
				onChange={() => {}}
				placeholder="Filter…"
				ariaLabel="Search environments"
			/>,
		);
		expect(screen.getByLabelText("Search environments")).toBeInTheDocument();
	});

	it("round-trips typed input through onChange", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		const input = screen.getByLabelText("Filter by project…");
		await user.type(input, "api");
		expect(input).toHaveValue("api");
		expect(onChange).toHaveBeenLastCalledWith("api");
	});

	it("Esc clears a non-empty field", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} initial="api" />);
		const input = screen.getByLabelText("Filter by project…");
		input.focus();
		await user.keyboard("{Escape}");
		expect(onChange).toHaveBeenLastCalledWith("");
		expect(input).toHaveValue("");
	});

	it("Esc on an empty field does nothing and lets the key through", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const outer = vi.fn();
		render(
			<div onKeyDown={(e) => outer(e.key)}>
				<Harness onChange={onChange} />
			</div>,
		);
		screen.getByLabelText("Filter by project…").focus();
		await user.keyboard("{Escape}");
		expect(onChange).not.toHaveBeenCalled();
		expect(outer).toHaveBeenCalledWith("Escape");
	});

	it("without slashToFocus, `/` does nothing and there is no key hint", async () => {
		const user = userEvent.setup();
		const { container } = render(<Harness onChange={vi.fn()} />);
		await user.keyboard("/");
		expect(screen.getByLabelText("Filter by project…")).not.toHaveFocus();
		expect(container.querySelector('[data-slot="filter-search-hint"]')).toBeNull();
		expect(screen.getByLabelText("Filter by project…")).not.toHaveAttribute("aria-keyshortcuts");
	});

	it("with slashToFocus, `/` from the page focuses the field without typing a slash", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const { container } = render(<Harness onChange={onChange} slashToFocus />);
		const input = screen.getByLabelText("Filter by project…");
		expect(container.querySelector('[data-slot="filter-search-hint"]')).toHaveTextContent("/");
		expect(input).toHaveAttribute("aria-keyshortcuts", "/");

		await user.keyboard("/");
		expect(input).toHaveFocus();
		expect(input).toHaveValue("");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("`/` with a modifier is left alone", async () => {
		const user = userEvent.setup();
		render(<Harness onChange={vi.fn()} slashToFocus />);
		await user.keyboard("{Control>}/{/Control}");
		expect(screen.getByLabelText("Filter by project…")).not.toHaveFocus();
	});

	it("`/` typed into another field, a textarea or a contenteditable stays there", async () => {
		const user = userEvent.setup();
		render(
			<>
				<Harness onChange={vi.fn()} slashToFocus />
				<input aria-label="Other" />
				<textarea aria-label="Notes" />
				<div aria-label="Editor" contentEditable suppressContentEditableWarning role="textbox" tabIndex={0} />
			</>,
		);
		const search = screen.getByLabelText("Filter by project…");
		for (const name of ["Other", "Notes"]) {
			const field = screen.getByLabelText(name);
			await user.click(field);
			await user.keyboard("/");
			expect(field).toHaveFocus();
			expect(field).toHaveValue("/");
			expect(search).not.toHaveFocus();
		}
		const editor = screen.getByLabelText("Editor");
		editor.focus();
		await user.keyboard("/");
		expect(editor).toHaveFocus();
	});

	it("removes its `/` listener on unmount", async () => {
		const user = userEvent.setup();
		const remove = vi.spyOn(document, "removeEventListener");
		const { unmount } = render(<Harness onChange={vi.fn()} slashToFocus />);
		unmount();
		expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
		remove.mockRestore();
		// And nothing on the page answers `/` any more.
		await user.keyboard("/");
		expect(document.activeElement).toBe(document.body);
	});
});

describe("isTypingTarget", () => {
	it("is true for text fields, contenteditable and text-box roles, false for a button or nothing", () => {
		const input = document.createElement("input");
		const textarea = document.createElement("textarea");
		const select = document.createElement("select");
		const combo = document.createElement("div");
		combo.setAttribute("role", "combobox");
		const button = document.createElement("button");
		expect(isTypingTarget(input)).toBe(true);
		expect(isTypingTarget(textarea)).toBe(true);
		expect(isTypingTarget(select)).toBe(true);
		expect(isTypingTarget(combo)).toBe(true);
		expect(isTypingTarget(button)).toBe(false);
		expect(isTypingTarget(null)).toBe(false);
	});

	it("is true inside an open dialog or menu, which own the keyboard", () => {
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const inner = document.createElement("button");
		dialog.append(inner);
		document.body.append(dialog);
		expect(isTypingTarget(inner)).toBe(true);
		dialog.remove();
	});
});
