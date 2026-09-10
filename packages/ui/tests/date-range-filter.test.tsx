// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatInTimeZone } from "date-fns-tz";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DateRangeFilter } from "../src/date-range-filter";
import { localTimeZone, presetRange } from "../src/range";

const TZ = localTimeZone();

function renderFilter() {
	const onChange = vi.fn();
	const utils = render(
		<DateRangeFilter value={presetRange("7d")} onChange={onChange} />,
	);
	return { onChange, ...utils };
}

describe("DateRangeFilter", () => {
	it("shows the resolved range on the trigger", () => {
		renderFilter();
		// The CalendarDays trigger's accessible name is the formatted range (has an en-dash).
		expect(screen.getByRole("button", { name: /–|—/ })).toBeInTheDocument();
	});

	// THE OTHER DIRECTION, and the one that was a live bug: the label must be absent from the
	// SERVER's HTML. `formatRangeLabel` reads the viewer's zone and, through `presetRange`, the
	// wall clock to the minute — neither of which the server shares with the browser. Rendered
	// during hydration it is React #418 ("text content did not match"), which the release gate's
	// audit leg fails the route on. Intermittent in CI, where both halves share a clock and a
	// zone and must straddle a minute boundary; near-constant against a UTC server.
	it("does not put the clock/zone-derived label in the server-rendered HTML", () => {
		const html = renderToString(
			<DateRangeFilter value={presetRange("7d")} onChange={() => {}} />,
		);
		// No range separator and no meridiem — the two halves of `formatRangeLabel`'s output.
		expect(html).not.toMatch(/–|—/);
		expect(html).not.toMatch(/\d(am|pm)/i);
		// It still renders a trigger the reader can see and click.
		expect(html).toMatch(/Date range/);
	});

	it("opens to a calendar + start/end date+time inputs", async () => {
		const user = userEvent.setup();
		renderFilter();
		await user.click(screen.getByRole("button", { name: /–|—/ }));

		// The popover content is portaled to document.body, not the render container.
		expect(document.querySelectorAll('input[type="date"]')).toHaveLength(2);
		expect(document.querySelectorAll('input[type="time"]')).toHaveLength(2);
		// react-day-picker renders a grid of day buttons.
		expect(screen.getByRole("grid")).toBeInTheDocument();
	});

	it("commits the edited start/end dates on Apply", async () => {
		const user = userEvent.setup();
		const { onChange } = renderFilter();
		await user.click(screen.getByRole("button", { name: /–|—/ }));

		const dates = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
		fireEvent.change(dates[0], { target: { value: "2026-06-01" } });
		fireEvent.change(dates[1], { target: { value: "2026-06-10" } });
		await user.click(screen.getByRole("button", { name: /apply/i }));

		expect(onChange).toHaveBeenCalledTimes(1);
		const [range] = onChange.mock.calls[0];
		// The committed instants render back to the civil days we entered (in the picker's tz).
		expect(formatInTimeZone(range.from, TZ, "yyyy-MM-dd")).toBe("2026-06-01");
		expect(formatInTimeZone(range.to, TZ, "yyyy-MM-dd")).toBe("2026-06-10");
		expect(range.from.getTime()).toBeLessThan(range.to.getTime());
	});

	it("renders the timezone selector with the local zone", async () => {
		const user = userEvent.setup();
		renderFilter();
		await user.click(screen.getByRole("button", { name: /–|—/ }));
		// The Select trigger (combobox) shows the chosen zone.
		const combo = screen.getByRole("combobox");
		expect(within(combo).getByText(new RegExp(TZ.replace(/\//g, ".")))).toBeInTheDocument();
	});
});
