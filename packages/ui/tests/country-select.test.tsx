// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the searchable CountrySelect combobox: it renders every entry of
// COUNTRY_OPTIONS inside its popover, emits the ISO-2 code on select, filters as
// you type, and reflects the current value on the trigger.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CountrySelect } from "../src/country-select";
import { pasteQuery } from "./interactions";

// CountrySelect renders one cmdk CommandItem per COUNTRY_OPTIONS entry, unvirtualized
// (country-select.tsx:88), so every popover-open mounts the whole list. #1453 stubbed the flag SVGs
// and took this file from ~78s to ~32s, but the residual is the ITEM COUNT rather than the SVG
// payload: with the stub active, opening the popover and typing NOTHING still cost ~5.8s for 254
// items, and each of the four popover tests paid it again.
//
// So the list is narrowed here. Only COUNTRY_OPTIONS is replaced — `countryName` stays REAL, because
// the trigger-label cases ("BG" → Bulgaria, unknown "ZZ" → "ZZ") are asserting that real lookup, not
// a fixture. CountrySelect takes no country-list prop and must not grow a test-only one: #1453
// settled that the seam belongs at the module boundary. The real list is guarded below.
const { TEST_COUNTRIES } = vi.hoisted(() => ({
	TEST_COUNTRIES: [
		{ code: "BG", name: "Bulgaria" },
		{ code: "DE", name: "Germany" },
		{ code: "US", name: "United States" },
		{ code: "FR", name: "France" },
		{ code: "JP", name: "Japan" },
	],
}));

vi.mock("../src/countries", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/countries")>()),
	COUNTRY_OPTIONS: TEST_COUNTRIES,
}));

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
		const user = userEvent.setup({ delay: null });
		render(<CountrySelect value="" onChange={vi.fn()} />);

		const trigger = screen.getByRole("button");
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");

		// The full list is rendered (portaled to document.body); spot-check a few.
		expect(label("Bulgaria")).toBeInTheDocument();
		expect(label("Germany")).toBeInTheDocument();
		expect(label("United States")).toBeInTheDocument();
		// EVERY option is rendered, not merely "lots of them". Against a known list this is a
		// stricter statement than the previous `> 50`: a component that silently dropped or
		// deduplicated entries would have satisfied that bound and fails this.
		expect(screen.getAllByRole("option")).toHaveLength(TEST_COUNTRIES.length);
	});

	it("fires onChange with the ISO-2 code when a country is selected and closes", async () => {
		const user = userEvent.setup({ delay: null });
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
		const user = userEvent.setup({ delay: null });
		render(<CountrySelect value="" onChange={vi.fn()} />);

		await user.click(screen.getByRole("button"));
		const search = screen.getByPlaceholderText(/search country/i);
		await pasteQuery(user, search, "Bulgaria");

		expect(label("Bulgaria")).toBeInTheDocument();
		// Non-matching options are filtered out by cmdk.
		expect(queryLabel("Germany")).not.toBeInTheDocument();
		expect(queryLabel("United States")).not.toBeInTheDocument();
	});

	it("shows the empty state for a query that matches nothing", async () => {
		const user = userEvent.setup({ delay: null });
		render(<CountrySelect value="" onChange={vi.fn()} />);

		await user.click(screen.getByRole("button"));
		await pasteQuery(
			user,
			screen.getByPlaceholderText(/search country/i),
			"zzzznotacountry",
		);

		expect(screen.getByText(/no country found/i)).toBeInTheDocument();
		expect(queryLabel("Bulgaria")).not.toBeInTheDocument();
	});

	// The tests above run against a 5-country stand-in, so nothing else in this file would notice if
	// the REAL module changed shape — a renamed/emptied COUNTRY_OPTIONS would leave the mock happily
	// green while the component rendered nothing in production. This is the guard for that: it reads
	// the real module and pins the contract the mock is standing in for.
	it("the mock stands in for a real, fully-populated COUNTRY_OPTIONS", async () => {
		const actual =
			await vi.importActual<typeof import("../src/countries")>(
				"../src/countries",
			);

		// Derived from react-phone-number-input's locale data — the real list is the whole world.
		expect(actual.COUNTRY_OPTIONS.length).toBeGreaterThan(200);
		// Same row shape the stand-in uses, so the mock cannot drift from it silently.
		expect(actual.COUNTRY_OPTIONS[0]).toEqual({
			code: expect.any(String),
			name: expect.any(String),
		});
		expect(actual.COUNTRY_OPTIONS.map((c) => c.code)).toEqual(
			expect.arrayContaining(TEST_COUNTRIES.map((c) => c.code)),
		);
		// countryName is NOT mocked; these are the lookups the trigger tests above rely on.
		expect(actual.countryName("BG")).toBe("Bulgaria");
		expect(actual.countryName("ZZ")).toBe("ZZ");
	});

	it("does not open or emit when disabled", async () => {
		const user = userEvent.setup({ delay: null });
		const onChange = vi.fn();
		render(<CountrySelect value="" onChange={onChange} disabled />);

		const trigger = screen.getByRole("button");
		expect(trigger).toBeDisabled();
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(onChange).not.toHaveBeenCalled();
	});
});
