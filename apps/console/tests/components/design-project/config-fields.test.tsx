// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The card's editing buffer. Every control used to write to the canvas store on each keystroke —
// through two whole-graph normalizers, an edge re-derive and a draft re-serialise — and two of the
// defects that made these cards hard to work were symptoms of it. A half-typed value now lives in
// the card and reaches the store once, on blur.
//
// The number semantics are the load-bearing part: an OPTIONAL (nullable-column) field commits NULL
// when cleared — "use the default" — because 0 trips the zod min(1) bound on the sizing columns; a
// REQUIRED one commits nothing at all and restores what was there, because 0 is a value the user
// did not type and it fights them the moment they backspace to retype.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import type { KindConfig } from "@/components/design-project/canvas/inspector/config-schema";

const SCHEMA: KindConfig = {
	sections: [
		{
			id: "sizing",
			title: "Sizing",
			defaultOpen: true,
			fields: [
				{
					key: "storage_gb",
					type: "number",
					label: "Storage",
					min: 1,
					max: 1024,
					optional: true,
				},
				{ key: "count", type: "number", label: "Count", min: 1, max: 10 },
				{ key: "label", type: "text", label: "Label" },
			],
		},
	],
	summary: () => "",
};

/** Renders the schema and returns the two number inputs. */
function renderFields(onChange: (patch: Record<string, unknown>) => void) {
	render(
		<ConfigFields
			schema={SCHEMA}
			config={{ storage_gb: 32, count: 2, label: "db" }}
			provider="hetzner"
			onChange={onChange}
		/>,
	);
	return screen.getAllByRole("spinbutton");
}

describe("ConfigFields — the buffer commits on blur, not on keystroke", () => {
	it("typing writes nothing until the field is left", () => {
		const onChange = vi.fn();
		const [storage] = renderFields(onChange);

		fireEvent.change(storage, { target: { value: "6" } });
		fireEvent.change(storage, { target: { value: "64" } });
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.blur(storage);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({ storage_gb: 64 });
	});

	it("a text field buffers too, and commits the whole word once", () => {
		const onChange = vi.fn();
		renderFields(onChange);
		const label = screen.getByRole("textbox");

		fireEvent.change(label, { target: { value: "orders" } });
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.blur(label);
		expect(onChange).toHaveBeenCalledWith({ label: "orders" });
	});

	it("shows what you type while you type it, empty string included", () => {
		const [storage] = renderFields(vi.fn());
		fireEvent.change(storage, { target: { value: "" } });
		expect(storage).toHaveValue(null);
	});
});

describe("ConfigFields — number fields", () => {
	it("commits NULL when an optional number field is cleared", () => {
		const onChange = vi.fn();
		const [storage] = renderFields(onChange);

		fireEvent.change(storage, { target: { value: "" } });
		fireEvent.blur(storage);

		expect(onChange).toHaveBeenCalledWith({ storage_gb: null });
	});

	it("NEVER writes 0 when a required number field is cleared", () => {
		const onChange = vi.fn();
		const [, count] = renderFields(onChange);

		fireEvent.change(count, { target: { value: "" } });
		fireEvent.blur(count);

		expect(onChange).not.toHaveBeenCalled();
		// …and the field shows what is still stored, rather than a 0 nobody typed.
		expect(count).toHaveValue(2);
	});

	it("clearing and retyping a required field commits only the new value", () => {
		const onChange = vi.fn();
		const [, count] = renderFields(onChange);

		fireEvent.change(count, { target: { value: "" } });
		fireEvent.change(count, { target: { value: "7" } });
		fireEvent.blur(count);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({ count: 7 });
	});

	it("renders a NULL value as an empty input (placeholder territory)", () => {
		render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: null, count: 2 }}
				provider="hetzner"
				onChange={vi.fn()}
			/>,
		);
		const [storage] = screen.getAllByRole("spinbutton");
		expect(storage).toHaveValue(null);
	});
});
