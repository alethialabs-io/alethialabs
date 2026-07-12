// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Number inputs in the inspector's generic field renderer: an OPTIONAL (nullable-column)
// field patches NULL when cleared — "use the default" — because 0 would trip the zod
// min(1) bound on the sizing columns and block the save with no way back. Required
// number fields keep the legacy clear→0 behavior so they can never go null.

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
			],
		},
	],
	summary: () => "",
};

/** Renders the two-field schema and returns the [optional, required] number inputs. */
function renderFields(onChange: (patch: Record<string, unknown>) => void) {
	render(
		<ConfigFields
			schema={SCHEMA}
			config={{ storage_gb: 32, count: 2 }}
			provider="hetzner"
			onChange={onChange}
		/>,
	);
	return screen.getAllByRole("spinbutton");
}

describe("ConfigFields — number inputs", () => {
	it("patches NULL when an optional number field is cleared", () => {
		const onChange = vi.fn();
		const [storage] = renderFields(onChange);

		fireEvent.change(storage, { target: { value: "" } });

		expect(onChange).toHaveBeenCalledWith({ storage_gb: null });
	});

	it("keeps clear→0 for required number fields", () => {
		const onChange = vi.fn();
		const [, count] = renderFields(onChange);

		fireEvent.change(count, { target: { value: "" } });

		expect(onChange).toHaveBeenCalledWith({ count: 0 });
	});

	it("still patches parsed integers on normal input", () => {
		const onChange = vi.fn();
		const [storage] = renderFields(onChange);

		fireEvent.change(storage, { target: { value: "64" } });

		expect(onChange).toHaveBeenCalledWith({ storage_gb: 64 });
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
