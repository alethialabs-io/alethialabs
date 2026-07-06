// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the GroupedFilterSheet: a trigger opens a Sheet of collapsible,
// multi-select option groups. We exercise the real component (controlled value +
// onChange) through a stateful harness so we can assert the *combined* value that
// accumulates across interactions, the per-group + trigger active counts, the
// select-all toggle, and clear-all.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	type GroupedFilterGroup,
	GroupedFilterSheet,
} from "../src/grouped-filter-sheet";

const GROUPS: GroupedFilterGroup[] = [
	{
		label: "Auth",
		options: [
			{ value: "login", label: "Login" },
			{ value: "logout", label: "Logout" },
		],
	},
	{
		label: "Billing",
		options: [
			{ value: "invoice", label: "Invoice" },
			{ value: "refund", label: "Refund" },
		],
	},
];

/**
 * Renders the real component as a controlled component (state lives here, like a
 * real caller) and spies on every emitted value so we can assert combined output.
 */
function Harness({
	onChange,
	initial = [],
}: {
	onChange: (next: string[]) => void;
	initial?: string[];
}) {
	const [value, setValue] = useState<string[]>(initial);
	return (
		<GroupedFilterSheet
			label="Event types"
			title="Filter events"
			description="Pick which events to show"
			groups={GROUPS}
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange(next);
			}}
		/>
	);
}

/** The outer trigger button (carries the label + active-count badge). */
function trigger() {
	return screen.getByRole("button", { name: /event types/i });
}

describe("GroupedFilterSheet", () => {
	it("renders all groups inside the sheet once opened", async () => {
		const user = userEvent.setup();
		render(<Harness onChange={vi.fn()} />);

		// Groups are not in the DOM before the sheet is opened.
		expect(screen.queryByText("Auth")).not.toBeInTheDocument();
		expect(screen.queryByText("Billing")).not.toBeInTheDocument();

		await user.click(trigger());

		expect(screen.getByText("Filter events")).toBeInTheDocument();
		expect(screen.getByText("Pick which events to show")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Auth" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Billing" })).toBeInTheDocument();
	});

	it("accumulates the combined value across options in different groups", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		await user.click(trigger());

		// Expand the Auth group, then pick two options.
		await user.click(screen.getByRole("button", { name: "Auth" }));
		await user.click(screen.getByRole("button", { name: "Login" }));
		expect(onChange).toHaveBeenLastCalledWith(["login"]);

		await user.click(screen.getByRole("button", { name: "Logout" }));
		expect(onChange).toHaveBeenLastCalledWith(["login", "logout"]);

		// Expand Billing and add a third — combined value spans both groups.
		await user.click(screen.getByRole("button", { name: "Billing" }));
		await user.click(screen.getByRole("button", { name: "Invoice" }));
		expect(onChange).toHaveBeenLastCalledWith(["login", "logout", "invoice"]);

		// Toggling an already-selected option removes just that one.
		await user.click(screen.getByRole("button", { name: "Logout" }));
		expect(onChange).toHaveBeenLastCalledWith(["login", "invoice"]);
	});

	it("reflects the active count on the trigger and per group", async () => {
		const user = userEvent.setup();
		render(<Harness onChange={vi.fn()} />);

		// No badge / count before anything is selected.
		expect(trigger()).toHaveTextContent(/^Event types$/);

		await user.click(trigger());
		await user.click(screen.getByRole("button", { name: /^auth/i }));
		await user.click(screen.getByRole("button", { name: "Login" }));
		// The group's collapsible trigger carries its own count badge ("Auth 1").
		expect(screen.getByRole("button", { name: /^auth/i })).toHaveTextContent("1");

		await user.click(screen.getByRole("button", { name: "Logout" }));
		expect(screen.getByRole("button", { name: /^auth/i })).toHaveTextContent("2");

		// Close the sheet (the outer trigger is aria-hidden while it's open) and
		// confirm the trigger badge reflects the total selection.
		await user.keyboard("{Escape}");
		expect(trigger()).toHaveTextContent("2");
	});

	it("select-all toggles every option in a group at once", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		await user.click(trigger());

		// Each group header has a select-all checkbox button.
		const selectAll = screen.getAllByRole("button", { name: "Select all" });
		expect(selectAll).toHaveLength(2);

		await user.click(selectAll[0]); // Auth
		expect(onChange).toHaveBeenLastCalledWith(["login", "logout"]);

		// Now fully selected → it becomes a "Deselect all" toggle.
		const deselect = screen.getByRole("button", { name: "Deselect all" });
		await user.click(deselect);
		expect(onChange).toHaveBeenLastCalledWith([]);
	});

	it("clear-all resets every selection", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<Harness onChange={onChange} initial={["login", "invoice", "refund"]} />,
		);
		await user.click(trigger());

		// Clear button is labelled with the current count.
		const clear = screen.getByRole("button", { name: /clear 3 selected/i });
		await user.click(clear);
		expect(onChange).toHaveBeenLastCalledWith([]);

		// The clear button disappears once nothing is selected.
		expect(
			screen.queryByRole("button", { name: /clear .* selected/i }),
		).not.toBeInTheDocument();

		// Close the sheet and confirm the trigger has dropped its count badge.
		await user.keyboard("{Escape}");
		expect(trigger()).toHaveTextContent(/^Event types$/);
	});
});
