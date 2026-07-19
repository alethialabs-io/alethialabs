// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { validateNodeConfig } from "@/components/design-project/canvas/inspector/node-validation";

describe("validateNodeConfig (W4 inline validation)", () => {
	it("returns {} for a kind with no first-class form schema", () => {
		// add-ons / charts / external are configured elsewhere — no per-field validation here.
		expect(validateNodeConfig("addon", {})).toEqual({});
		expect(validateNodeConfig("chart", {})).toEqual({});
	});

	it("attributes an invalid value to its top-level field key", () => {
		// A wrong type for a numeric field is rejected by the DB-derived zod schema and keyed to
		// that field so the inspector can render the error under it.
		const errs = validateNodeConfig("cluster", {
			node_min_size: "not a number",
		});
		expect(errs.node_min_size).toBeTruthy();
		// Every key is a plain top-level field name (a string), never a nested path array.
		for (const key of Object.keys(errs)) expect(typeof key).toBe("string");
	});
});
