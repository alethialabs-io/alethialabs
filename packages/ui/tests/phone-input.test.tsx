// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RTL test for the authored @repo/ui PhoneInput composite: it wraps
// react-phone-number-input with our grayscale country picker + Input, is
// controlled on an E.164 string, and emits E.164 (normalizing the library's
// `undefined` empty value to ""). We render the REAL component inside a small
// stateful wrapper (it's controlled) and assert real behavior: typing a national
// number forwards a fully-composed E.164 value, picking a country re-prefixes the
// dial code, and clearing emits "".

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PhoneInput } from "../src/phone-input";

/**
 * Renders the real PhoneInput controlled by local state (mirrors a RHF
 * Controller) and forwards each emitted E.164 value to a spy.
 */
function renderPhone(defaultCountry: "US" | "DE" = "US") {
	const onChange = vi.fn();
	function Controlled() {
		const [value, setValue] = React.useState<string>("");
		return (
			<PhoneInput
				defaultCountry={defaultCountry}
				value={value}
				onChange={(v) => {
					setValue(v);
					onChange(v);
				}}
			/>
		);
	}
	render(<Controlled />);
	// The only <button> is the country-select trigger; the number field is a textbox.
	const trigger = screen.getByRole("button");
	const input = screen.getByRole("textbox") as HTMLInputElement;
	return { onChange, trigger, input };
}

/** The latest value handed to the spy. */
function lastValue(onChange: ReturnType<typeof vi.fn>): string {
	return onChange.mock.calls.at(-1)?.[0];
}

describe("PhoneInput", () => {
	it("forwards a fully composed E.164 value as the national number is typed", async () => {
		const user = userEvent.setup();
		const { onChange, input } = renderPhone("US");

		await user.type(input, "2025550123");

		// onChange fired and the final emission is the US-prefixed E.164 number.
		expect(onChange).toHaveBeenCalled();
		expect(lastValue(onChange)).toBe("+12025550123");
		// And the field shows the library's national formatting (not raw digits).
		expect(input.value).toMatch(/\(?202\)?\s?555/);
	});

	it("emits an empty string (not undefined) when the number is cleared", async () => {
		const user = userEvent.setup();
		const { onChange, input } = renderPhone("US");

		await user.type(input, "2025550123");
		onChange.mockClear();
		await user.clear(input);

		expect(onChange).toHaveBeenCalled();
		// The component normalizes RPNI's `undefined` empty value to "".
		expect(lastValue(onChange)).toBe("");
	});

	it("re-prefixes the dial code when a different country is selected", async () => {
		const user = userEvent.setup();
		const { onChange, trigger, input } = renderPhone("US");

		// Enter a national number under the default US country first.
		await user.type(input, "2025550123");
		expect(lastValue(onChange)).toBe("+12025550123");

		// Open the country picker and choose Germany via the searchable command list.
		await user.click(trigger);
		const search = screen.getByPlaceholderText(/search country/i);
		await user.type(search, "Germany");
		const option = await screen.findByRole("option", { name: /germany/i });
		// The option surfaces the +49 dial code alongside the country label.
		expect(within(option).getByText("+49")).toBeInTheDocument();
		await user.click(option);

		// The composed value now carries Germany's calling code instead of +1.
		expect(lastValue(onChange)).toMatch(/^\+49/);
		expect(lastValue(onChange)).not.toMatch(/^\+1\d/);
	});

	it("opens a searchable list and filters out non-matching countries", async () => {
		const user = userEvent.setup();
		const { trigger } = renderPhone("US");

		await user.click(trigger);
		await user.type(screen.getByPlaceholderText(/search country/i), "zzzznotacountry");

		// The CommandEmpty fallback shows when nothing matches.
		expect(await screen.findByText(/no country found/i)).toBeInTheDocument();
	});
});
