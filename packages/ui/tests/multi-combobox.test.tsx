// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the MultiCombobox typeahead multi-select: open-on-focus, toggle
// semantics, the selected summary, typed filtering, clearing, and the per-option
// `leading` node (e.g. a provider icon).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MultiCombobox, type ComboboxOption } from "../src/multi-combobox";

const OPTIONS: ComboboxOption[] = [
	{ value: "aws", label: "AWS", hint: "2", leading: <span data-testid="icon-aws" /> },
	{ value: "gcp", label: "GCP", hint: "2" },
	{ value: "hetzner", label: "Hetzner" },
];

/** Stateful harness so the controlled combobox toggles across re-renders. */
function Harness({ onChange }: { onChange: (next: string[]) => void }) {
	const [value, setValue] = useState<string[]>([]);
	return (
		<MultiCombobox
			options={OPTIONS}
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange(next);
			}}
			placeholder="All clouds"
		/>
	);
}

describe("MultiCombobox", () => {
	it("opens on focus and toggles options, keeping the list open", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		await user.click(screen.getByPlaceholderText("All clouds"));
		await user.click(screen.getByRole("button", { name: /aws/i }));
		expect(onChange).toHaveBeenLastCalledWith(["aws"]);

		// list stays open — a second toggle works without reopening
		await user.click(screen.getByRole("button", { name: /gcp/i }));
		expect(onChange).toHaveBeenLastCalledWith(["aws", "gcp"]);

		// summary reflects the multi-selection
		expect(screen.getByPlaceholderText("2 selected")).toBeInTheDocument();
	});

	it("filters options by typed query", async () => {
		const user = userEvent.setup();
		render(<Harness onChange={() => {}} />);

		const input = screen.getByPlaceholderText("All clouds");
		await user.type(input, "hetz");
		expect(screen.getByRole("button", { name: /hetzner/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /aws/i })).not.toBeInTheDocument();
	});

	it("renders per-option leading nodes and hints", async () => {
		const user = userEvent.setup();
		render(<Harness onChange={() => {}} />);

		await user.click(screen.getByPlaceholderText("All clouds"));
		expect(screen.getByTestId("icon-aws")).toBeInTheDocument();
		const aws = screen.getByRole("button", { name: /aws/i });
		expect(aws.textContent).toContain("2");
	});

	it("clears the whole selection from the footer", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);

		await user.click(screen.getByPlaceholderText("All clouds"));
		await user.click(screen.getByRole("button", { name: /aws/i }));
		await user.click(screen.getByRole("button", { name: /clear 1 selected/i }));
		expect(onChange).toHaveBeenLastCalledWith([]);
	});
});
