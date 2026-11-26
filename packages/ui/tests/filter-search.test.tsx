// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the FilterSearch input: controlled value round-trip, the placeholder-as-accessible-name
// fallback, Esc to clear, and the shortcut hint (#7737). The `/` key itself is the console registry's
// (`useListSearchShortcut`): this component draws a hint only when told the key is live, exposes its
// input through `inputRef`, and installs no page-level listener of its own.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilterSearch } from "../src/filter-search";

/** Stateful harness so the controlled input actually accepts typing. */
function Harness({
	onChange,
	initial = "",
}: {
	onChange: (v: string) => void;
	initial?: string;
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

	it("without a shortcut there is no hint and no aria-keyshortcuts, and `/` does nothing", async () => {
		const user = userEvent.setup();
		const { container } = render(<Harness onChange={vi.fn()} />);
		const input = screen.getByLabelText("Filter by project…");
		expect(container.querySelector('[data-slot="filter-search-hint"]')).toBeNull();
		expect(input).not.toHaveAttribute("aria-keyshortcuts");
		await user.keyboard("/");
		expect(input).not.toHaveFocus();
	});

	it("with a shortcut it draws the hint and states the key — and still answers no key itself", async () => {
		const user = userEvent.setup();
		const { container } = render(
			<FilterSearch
				value=""
				onChange={() => {}}
				placeholder="Search"
				shortcut={{ hint: "/", ariaKeyShortcuts: "/" }}
			/>,
		);
		const input = screen.getByLabelText("Search");
		expect(container.querySelector('[data-slot="filter-search-hint"]')).toHaveTextContent("/");
		expect(input).toHaveAttribute("aria-keyshortcuts", "/");
		// The console's registry answers the key; this component installs no listener for it.
		await user.keyboard("/");
		expect(input).not.toHaveFocus();
	});

	it("exposes its input through inputRef, for the caller's shortcut to focus", () => {
		const ref = createRef<HTMLInputElement>();
		render(<FilterSearch value="" onChange={() => {}} placeholder="Search" inputRef={ref} />);
		expect(ref.current).toBe(screen.getByLabelText("Search"));
	});
});
