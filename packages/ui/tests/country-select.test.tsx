// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the searchable CountrySelect combobox: it renders the full
// country list from countries.ts inside its popover, emits the ISO-2 code on
// select, filters as you type, and reflects the current value on the trigger.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CountrySelect } from "../src/country-select";

// Each option renders the country name twice: once in the flag SVG's <title> and
// once in the visible label <span class="flex-1">. Scope lookups to the label
// span so queries are unambiguous.
const label = (name: string) =>
	screen.getByText(name, { selector: "span.flex-1" });
const queryLabel = (name: string) =>
	screen.queryByText(name, { selector: "span.flex-1" });

describe("CountrySelect", () => {
	it("shows the placeholder when no value is set", () => {
		render(<CountrySelect value="" onChange={vi.fn()} placeholder="Pick one" />);
		expect(
			screen.getByRole("button", { name: /pick one/i }),
		).toBeInTheDocument();
	});

	it("reflects the initial value as the resolved country name on the trigger", () => {
		render(<CountrySelect value="BG" onChange={vi.fn()} />);
		const trigger = screen.getByRole("button");
		expect(trigger).toHaveTextContent("Bulgaria");
		// closed combobox
		expect(trigger).toHaveAttribute("aria-expanded", "false");
	});

	it("falls back to the raw code for an unknown value", () => {
		render(<CountrySelect value="ZZ" onChange={vi.fn()} />);
		// "ZZ" is not a real country option, so countryName returns the code itself.
		expect(screen.getByRole("button")).toHaveTextContent("ZZ");
	});

	it("opens the popover and lists multiple country options", async () => {
		const user = userEvent.setup();
		render(<CountrySelect value="" onChange={vi.fn()} />);

		const trigger = screen.getByRole("button");
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");

		// The full list is rendered (portaled to document.body); spot-check a few.
		expect(label("Bulgaria")).toBeInTheDocument();
		expect(label("Germany")).toBeInTheDocument();
		expect(label("United States")).toBeInTheDocument();
		// cmdk renders each option as an option role.
		expect(screen.getAllByRole("option").length).toBeGreaterThan(50);
	});

	it("fires onChange with the ISO-2 code when a country is selected and closes", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<CountrySelect value="" onChange={onChange} />);

		const trigger = screen.getByRole("button");
		await user.click(trigger);
		await user.click(label("Germany"));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("DE");
		// Popover closes after a selection.
		expect(trigger).toHaveAttribute("aria-expanded", "false");
	});

	it("narrows the list to matches as you type in the search box", async () => {
		const user = userEvent.setup();
		render(<CountrySelect value="" onChange={vi.fn()} />);

		await user.click(screen.getByRole("button"));
		const search = screen.getByPlaceholderText(/search country/i);
		await user.type(search, "Bulgaria");

		expect(label("Bulgaria")).toBeInTheDocument();
		// Non-matching options are filtered out by cmdk.
		expect(queryLabel("Germany")).not.toBeInTheDocument();
		expect(queryLabel("United States")).not.toBeInTheDocument();
	});

	it("shows the empty state for a query that matches nothing", async () => {
		const user = userEvent.setup();
		render(<CountrySelect value="" onChange={vi.fn()} />);

		await user.click(screen.getByRole("button"));
		await user.type(
			screen.getByPlaceholderText(/search country/i),
			"zzzznotacountry",
		);

		expect(screen.getByText(/no country found/i)).toBeInTheDocument();
		expect(queryLabel("Bulgaria")).not.toBeInTheDocument();
	});

	it("does not open or emit when disabled", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<CountrySelect value="" onChange={onChange} disabled />);

		const trigger = screen.getByRole("button");
		expect(trigger).toBeDisabled();
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(onChange).not.toHaveBeenCalled();
	});
});
