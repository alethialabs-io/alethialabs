// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The control behind `instance_class` and a cache `engine_version` (#1375).
//
// These two fields carry values a cloud API may never list back: a SKU only orderable on an older
// engine version, a GCP custom machine type, anything at all on an account that hasn't synced, and —
// on the three clouds that document a cache-version exclusion — every value. Making them a `<Select>`
// would have quietly removed the ability to pin one, which is why the control is a combobox instead.
//
// What is pinned here is that free entry SURVIVES: the suggestions are additive. That is the exact
// property a select cannot have, so it is the property worth a test rather than a review note.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OptionCombobox } from "@/components/design-project/canvas/inspector/config-fields";

const SUGGESTIONS = [
	{ value: "db.r6g.large", label: "db.r6g.large · 16 GB" },
	{ value: "db.r6g.xlarge", label: "db.r6g.xlarge · 32 GB" },
	{
		value: "db.t4g.micro",
		label: "db.t4g.micro · 1 GB",
		advisory: { level: "unavailable" as const, note: "Your quota for this family is 0." },
	},
];

/** Renders the control and returns its input + the onChange spy. */
function setup(value = "", options = SUGGESTIONS) {
	const onChange = vi.fn();
	render(
		<OptionCombobox
			options={options}
			value={value}
			onChange={onChange}
			placeholder="resolver default"
			mono
		/>,
	);
	return { input: screen.getByRole("combobox"), onChange };
}

describe("OptionCombobox — an unlisted value stays typeable", () => {
	it("patches a value that is in no suggestion list", () => {
		const { input, onChange } = setup();
		fireEvent.change(input, { target: { value: "db.r6g.whatever" } });
		expect(onChange).toHaveBeenCalledWith("db.r6g.whatever");
	});

	it("keeps working with NO suggestions at all — the excluded clouds' case", () => {
		const { input, onChange } = setup("", []);
		fireEvent.change(input, { target: { value: "7.4" } });
		expect(onChange).toHaveBeenCalledWith("7.4");
		// Nothing to suggest ⇒ no list, but the field is still a field.
		fireEvent.focus(input);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("clears back to the default by emptying the input", () => {
		const { input, onChange } = setup("db.r6g.large");
		fireEvent.change(input, { target: { value: "" } });
		expect(onChange).toHaveBeenCalledWith("");
	});

	it("shows the stored value, never a blank control", () => {
		const { input } = setup("legacy-sku");
		expect(input).toHaveValue("legacy-sku");
	});
});

describe("OptionCombobox — the suggestions", () => {
	it("opens on focus and offers every account row", () => {
		const { input } = setup();
		fireEvent.focus(input);
		expect(screen.getByText("db.r6g.large · 16 GB")).toBeInTheDocument();
		expect(screen.getByText("db.r6g.xlarge · 32 GB")).toBeInTheDocument();
	});

	it("picking one patches its VALUE, not its label", () => {
		const { input, onChange } = setup();
		fireEvent.focus(input);
		fireEvent.click(screen.getByText("db.r6g.large · 16 GB"));
		expect(onChange).toHaveBeenCalledWith("db.r6g.large");
	});

	it("filters on what has been typed", () => {
		const { input } = setup("xlarge");
		fireEvent.focus(input);
		expect(screen.getByText("db.r6g.xlarge · 32 GB")).toBeInTheDocument();
		expect(screen.queryByText("db.r6g.large · 16 GB")).not.toBeInTheDocument();
	});

	it("says the typed value is kept when nothing matches — not that it is invalid", () => {
		const { input } = setup("db.r6g.whatever");
		fireEvent.focus(input);
		expect(screen.getByText(/kept as typed/i)).toBeInTheDocument();
	});

	it("renders an advisory as ink and leaves the row PICKABLE (#918)", () => {
		const { input, onChange } = setup();
		fireEvent.focus(input);
		const eyebrow = screen.getByText("unavailable");
		expect(eyebrow).toHaveAttribute("title", "Your quota for this family is 0.");
		// Guidance, never a gate: an option we believe is unavailable must still be selectable,
		// because the deploy is the authority and our verdict can be wrong or stale.
		fireEvent.click(screen.getByText("db.t4g.micro · 1 GB"));
		expect(onChange).toHaveBeenCalledWith("db.t4g.micro");
	});

	it("closes on blur so the list can't sit over the rest of the panel", () => {
		const { input } = setup();
		fireEvent.focus(input);
		expect(screen.getByText("db.r6g.large · 16 GB")).toBeInTheDocument();
		fireEvent.blur(input);
		expect(screen.queryByText("db.r6g.large · 16 GB")).not.toBeInTheDocument();
	});
});
