// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the multi-select FacetFilter: option rendering, toggle/onChange
// semantics, the selected-count badge, clearing, and search-within-facets.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FacetFilter, type FacetOption } from "../src/facet-filter";

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
}: {
	onChange: (next: string[]) => void;
	initial?: string[];
	options?: FacetOption[];
	label?: string;
}) {
	const [value, setValue] = useState<string[]>(initial);
	return (
		<FacetFilter
			label={label}
			options={options}
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange(next);
			}}
		/>
	);
}

/** Opens the popover by clicking the trigger and returns the onChange spy. */
async function open(
	user: ReturnType<typeof userEvent.setup>,
	props: Partial<Parameters<typeof Harness>[0]> = {},
) {
	const onChange = vi.fn();
	render(<Harness onChange={onChange} {...props} />);
	await user.click(screen.getByRole("button", { name: /^user/i }));
	return onChange;
}

describe("FacetFilter", () => {
	it("renders the trigger label with no count badge when nothing is selected", () => {
		render(<Harness onChange={vi.fn()} />);
		const trigger = screen.getByRole("button", { name: /^user/i });
		expect(trigger).toBeInTheDocument();
		// No numeric badge before any selection.
		expect(trigger).not.toHaveTextContent(/\d/);
	});

	it("renders every option (labels + hints) when opened", async () => {
		const user = userEvent.setup();
		await open(user);
		expect(screen.getByText("Alice")).toBeInTheDocument();
		expect(screen.getByText("Bob")).toBeInTheDocument();
		expect(screen.getByText("Carol")).toBeInTheDocument();
		expect(screen.getByText("alice@acme.io")).toBeInTheDocument();
	});

	it("fires onChange with the selected value and shows the count badge", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);

		await user.click(screen.getByText("Alice"));
		expect(onChange).toHaveBeenLastCalledWith(["alice"]);

		// The trigger badge now reflects one selection.
		expect(
			screen.getByRole("button", { name: /^user/i }),
		).toHaveTextContent("1");
	});

	it("accumulates multiple selections and updates the badge", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);

		await user.click(screen.getByText("Alice"));
		await user.click(screen.getByText("Carol"));

		expect(onChange).toHaveBeenLastCalledWith(["alice", "carol"]);
		expect(
			screen.getByRole("button", { name: /^user/i }),
		).toHaveTextContent("2");
	});

	it("deselects an already-selected option (toggle off)", async () => {
		const user = userEvent.setup();
		const onChange = await open(user, { initial: ["alice", "bob"] });

		// Pre-existing selection shows the count.
		expect(
			screen.getByRole("button", { name: /^user/i }),
		).toHaveTextContent("2");

		await user.click(screen.getByText("Alice"));
		expect(onChange).toHaveBeenLastCalledWith(["bob"]);
		expect(
			screen.getByRole("button", { name: /^user/i }),
		).toHaveTextContent("1");
	});

	it("clears all selections via the Clear button", async () => {
		const user = userEvent.setup();
		const onChange = await open(user, { initial: ["alice", "bob"] });

		const clear = screen.getByRole("button", { name: /clear 2 selected/i });
		await user.click(clear);

		expect(onChange).toHaveBeenLastCalledWith([]);
		// Badge gone and clear control no longer rendered.
		expect(
			screen.getByRole("button", { name: /^user/i }),
		).not.toHaveTextContent(/\d/);
		expect(
			screen.queryByRole("button", { name: /clear/i }),
		).not.toBeInTheDocument();
	});

	it("does not render the Clear button when nothing is selected", async () => {
		const user = userEvent.setup();
		await open(user);
		expect(
			screen.queryByRole("button", { name: /clear/i }),
		).not.toBeInTheDocument();
	});

	it("filters options via the search input and shows the empty fallback", async () => {
		const user = userEvent.setup();
		await open(user);

		const search = screen.getByPlaceholderText("Search…");
		await user.type(search, "bob");

		// Only the matching option survives the cmdk filter.
		expect(screen.getByText("Bob")).toBeInTheDocument();
		expect(screen.queryByText("Alice")).not.toBeInTheDocument();
		expect(screen.queryByText("Carol")).not.toBeInTheDocument();

		// A non-matching query surfaces the empty text.
		await user.clear(search);
		await user.type(search, "zzzz");
		expect(screen.getByText("No matches.")).toBeInTheDocument();
	});
});
