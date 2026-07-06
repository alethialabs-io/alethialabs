// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuickRangeFilter } from "../src/quick-range-filter";
import { presetRange } from "../src/range";

/** Renders the filter with a spy onChange and opens its popover. */
async function open(user: ReturnType<typeof userEvent.setup>) {
	const onChange = vi.fn();
	render(
		<QuickRangeFilter
			label="Last 7 days"
			value={presetRange("7d")}
			onChange={onChange}
		/>,
	);
	await user.click(screen.getByRole("button", { name: /last 7 days/i }));
	return onChange;
}

describe("QuickRangeFilter", () => {
	it("shows the current label on the trigger", () => {
		render(
			<QuickRangeFilter
				label="Last 30 days"
				value={presetRange("30d")}
				onChange={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: /last 30 days/i })).toBeInTheDocument();
	});

	it("emits the preset range + label when a preset is clicked", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);
		await user.click(screen.getByText("Last 14 days"));
		expect(onChange).toHaveBeenCalledTimes(1);
		const [range, label] = onChange.mock.calls[0];
		expect(label).toBe("Last 14 days");
		expect(range.from).toBeInstanceOf(Date);
		expect(range.to.getTime()).toBeGreaterThan(range.from.getTime());
	});

	it("parses a typed relative range on submit", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);
		const input = screen.getByPlaceholderText(/10d, 2 weeks/i);
		await user.type(input, "2 weeks{Enter}");
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0][1]).toBe("2 weeks");
	});

	it("resolves a chip click", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);
		await user.click(screen.getByText("yesterday"));
		expect(onChange).toHaveBeenCalledWith(expect.any(Object), "yesterday");
	});

	it("shows an error and does not emit for an unparseable entry", async () => {
		const user = userEvent.setup();
		const onChange = await open(user);
		await user.type(screen.getByPlaceholderText(/10d, 2 weeks/i), "garbage{Enter}");
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByText(/Try "10d"/)).toBeInTheDocument();
	});
});
