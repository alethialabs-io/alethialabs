// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the multi-select FacetFilter: option rendering, toggle/onChange semantics, the
// trigger naming its selection (`Name: A, B` / `Name · N`), the per-facet × clear, the search box
// past eight options, and keyboard operation without one (#7737).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FACET_SEARCH_THRESHOLD, FacetFilter, facetSummary, type FacetOption } from "../src/facet-filter";

const OPTIONS: FacetOption[] = [
	{ value: "alice", label: "Alice", hint: "alice@acme.io" },
	{ value: "bob", label: "Bob", hint: "bob@acme.io" },
	{ value: "carol", label: "Carol" },
];

/**
 * Stateful harness so the controlled FacetFilter actually toggles across
 * re-renders; exposes a spy that observes every onChange payload.
 */
function Harness({
	onChange,
	initial = [],
	options = OPTIONS,
	label = "User",
	searchable,
}: {
	onChange: (next: string[]) => void;
	initial?: string[];
	options?: FacetOption[];
	label?: string;
	searchable?: boolean;
}) {
	const [value, setValue] = useState<string[]>(initial);
	return (
		<FacetFilter
			label={label}
			options={options}
			searchable={searchable}
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange(next);
			}}
		/>
	);
}

/** Nine options: one past the threshold at which the popover grows a search box. */
const MANY: FacetOption[] = Array.from({ length: FACET_SEARCH_THRESHOLD + 1 }, (_, i) => ({
	value: `v${i}`,
	label: `Value ${i}`,
}));

/** The facet's popover trigger (named after the facet, then its selection). */
function trigger(name: RegExp = /^user/i): HTMLElement {
	return screen.getByRole("button", { name });
}

/** Opens the popover by clicking the trigger and returns the onChange spy. */
async function open(
	user: ReturnType<typeof userEvent.setup>,
	props: Partial<Parameters<typeof Harness>[0]> = {},
) {
	const onChange = vi.fn();
	render(<Harness onChange={onChange} {...props} />);
	await user.click(trigger());
	return onChange;
}

describe("FacetFilter", () => {
	it("reads `Name` in the secondary ink, with a chevron and no clear, when nothing is selected", () => {
		const { container } = render(<Harness onChange={vi.fn()} />);
		expect(trigger()).toHaveAccessibleName("User");
		expect(trigger().className).toContain("text-text-secondary");
		expect(trigger().querySelector("svg")).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Clear User" })).toBeNull();
		expect(container.querySelector('[data-slot="facet-filter"]')).toHaveAttribute("data-state", "idle");
	});

	it("renders every option (labels + hints) when opened", async () => {
		const user = userEvent.setup();
		await open(user);
		expect(screen.getByText("Alice")).toBeInTheDocument();
		expect(screen.getByText("Bob")).toBeInTheDocument();
		expect(screen.getByText("Carol")).toBeInTheDocument();
		expect(screen.getByText("alice@acme.io")).toBeInTheDocument();
	});

	it("names one selected value on the trigger, by its option label", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);

		await user.click(screen.getByText("Alice"));
		expect(onChange).toHaveBeenLastCalledWith(["alice"]);
		expect(trigger()).toHaveAccessibleName("User: Alice");
	});

	it("names two selected values, then switches to `Name · N` past two", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);

		await user.click(screen.getByText("Alice"));
		await user.click(screen.getByText("Carol"));
		expect(onChange).toHaveBeenLastCalledWith(["alice", "carol"]);
		expect(trigger()).toHaveAccessibleName("User: Alice, Carol");

		await user.click(screen.getByText("Bob"));
		expect(trigger()).toHaveTextContent("User · 3");
		expect(trigger()).toHaveAccessibleName("User 3 selected");
	});

	it("selected: a raised border and background, and the chevron gives way to the clear", () => {
		const { container } = render(<Harness onChange={vi.fn()} initial={["alice"]} />);
		expect(trigger().className).toContain("border-border-strong");
		expect(trigger().className).toContain("bg-surface-muted");
		expect(trigger().querySelector("svg")).toBeNull();
		expect(container.querySelector('[data-slot="facet-filter"]')).toHaveAttribute("data-state", "active");
	});

	it("the × is a real sibling button that clears this facet only", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} initial={["alice", "bob"]} />);

		const clear = screen.getByRole("button", { name: "Clear User" });
		// A sibling of the trigger, never nested inside it (a button in a button is unreachable).
		expect(trigger().contains(clear)).toBe(false);
		expect(clear.parentElement).toBe(trigger().parentElement);

		await user.click(clear);
		expect(onChange).toHaveBeenLastCalledWith([]);
		expect(trigger()).toHaveAccessibleName("User");
		expect(screen.queryByRole("button", { name: "Clear User" })).toBeNull();
	});

	it("the × is keyboard-operable", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} initial={["alice"]} />);
		screen.getByRole("button", { name: "Clear User" }).focus();
		await user.keyboard("{Enter}");
		expect(onChange).toHaveBeenLastCalledWith([]);
		// The × is gone with the selection; focus lands on the trigger, not the page.
		expect(trigger()).toHaveFocus();
	});

	it("deselects an already-selected option (toggle off)", async () => {
		const user = userEvent.setup();
		const onChange = await open(user, { initial: ["alice", "bob"] });
		expect(trigger()).toHaveAccessibleName("User: Alice, Bob");

		await user.click(screen.getByText("Alice"));
		expect(onChange).toHaveBeenLastCalledWith(["bob"]);
		expect(trigger()).toHaveAccessibleName("User: Bob");
	});

	it("falls back to the raw value, or the caller's formatValue, for a value with no option", () => {
		const { rerender } = render(
			<FacetFilter label="Region" options={[]} value={["eu-west-1"]} onChange={vi.fn()} />,
		);
		expect(trigger(/^region/i)).toHaveAccessibleName("Region: eu-west-1");
		rerender(
			<FacetFilter
				label="Region"
				options={[]}
				value={["eu-west-1"]}
				onChange={vi.fn()}
				formatValue={(v) => v.toUpperCase()}
			/>,
		);
		expect(trigger(/^region/i)).toHaveAccessibleName("Region: EU-WEST-1");
	});

	it("has no search box up to eight options, and the list takes the keyboard at once", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);
		expect(screen.queryByRole("combobox")).toBeNull();
		// Focus lands on the option list, which moves its highlight with the arrows and toggles on Enter.
		const listbox = screen.getByRole("listbox");
		await waitFor(() => expect(listbox).toHaveFocus());
		await user.keyboard("{ArrowDown}{Enter}");
		expect(onChange).toHaveBeenLastCalledWith(["bob"]);
	});

	it("names the search box after the facet when the placeholder is the generic one (#5803)", async () => {
		const user = userEvent.setup({ delay: null });
		await open(user, { options: MANY });
		// The search is named by the `Command` root's `label` (#5803; an unnamed search is a combobox a
		// screen reader cannot tell apart from any other).
		expect(
			screen.getByRole("combobox", { name: "Search User" }),
		).toHaveAttribute("placeholder", "Search…");
	});

	it("names the search box after a caller's placeholder, less its ellipsis (#5803)", async () => {
		const user = userEvent.setup({ delay: null });
		render(
			<FacetFilter
				label="Group"
				options={OPTIONS}
				value={[]}
				onChange={vi.fn()}
				searchable
				searchPlaceholder="Search groups…"
			/>,
		);
		await user.click(trigger(/^group/i));
		expect(
			screen.getByRole("combobox", { name: "Search groups" }),
		).toHaveAttribute("placeholder", "Search groups…");
	});

	it("past eight options, filters via the search input and shows the empty fallback", async () => {
		const user = userEvent.setup();
		await open(user, { options: [...OPTIONS, ...MANY] });

		const search = screen.getByPlaceholderText("Search…");
		await user.type(search, "bob");

		// Only the matching option survives the shared ranker.
		expect(screen.getByText("Bob")).toBeInTheDocument();
		expect(screen.queryByText("Alice")).not.toBeInTheDocument();
		expect(screen.queryByText("Carol")).not.toBeInTheDocument();

		// A non-matching query surfaces the empty text.
		await user.clear(search);
		await user.type(search, "zzzz");
		expect(screen.getByText("No matches.")).toBeInTheDocument();
	});

	// #6734: the on/off state reached assistive tech only as a drawn check, and the options were
	// unnamed. A facet option is an `option` in a multi-select `listbox`, so its state is
	// `aria-selected` and its name carries the trailing hint and count.
	it("exposes each option's selected state and names it with its hint and count", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<Harness
				onChange={onChange}
				label="Kind"
				options={[
					{ value: "builtin", label: "Built-in", count: 4 },
					{ value: "custom", label: "Custom", hint: "org", count: 2 },
				]}
			/>,
		);
		await user.click(trigger(/^kind/i));

		expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
		const builtIn = screen.getByRole("option", { name: "Built-in, 4" });
		const custom = screen.getByRole("option", { name: "Custom, org, 2" });
		expect(builtIn).toHaveAttribute("aria-selected", "false");
		expect(custom).toHaveAttribute("aria-selected", "false");
		// The 32px option row.
		expect(builtIn.className).toContain("h-8");

		await user.click(builtIn);
		expect(onChange).toHaveBeenLastCalledWith(["builtin"]);
		expect(screen.getByRole("option", { name: "Built-in, 4" })).toHaveAttribute("aria-selected", "true");
		// Selection is per row, not the highlight: the other row stays unselected.
		expect(screen.getByRole("option", { name: "Custom, org, 2" })).toHaveAttribute("aria-selected", "false");

		await user.click(screen.getByRole("option", { name: "Built-in, 4" }));
		expect(screen.getByRole("option", { name: "Built-in, 4" })).toHaveAttribute("aria-selected", "false");
	});

	it("names an option with neither hint nor count by its label alone", async () => {
		const user = userEvent.setup();
		await open(user);
		expect(screen.getByRole("option", { name: "Carol" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Alice, alice@acme.io" })).toBeInTheDocument();
	});
});

describe("facetSummary", () => {
	const upper = (v: string) => v.toUpperCase();

	it("is null with nothing selected", () => {
		expect(facetSummary([], upper)).toBeNull();
	});

	it("names up to two values, in selection order", () => {
		expect(facetSummary(["b", "a"], upper)).toEqual({ kind: "values", text: "B, A" });
	});

	it("counts past two", () => {
		expect(facetSummary(["a", "b", "c"], upper)).toEqual({ kind: "count", count: 3 });
	});
});
