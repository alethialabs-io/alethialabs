// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateRangeFilter } from "../src/date-range-filter";
import {
	formatInZone,
	formatRangeLabel,
	localTimeZone,
	parseRangeInput,
	presetRange,
	zonedWallClockToInstant,
} from "../src/range";

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

	// #5849: the server's trigger must already be as wide as the label that replaces it on mount.
	// A placeholder ~20 characters shorter than the label made the trigger grow at hydration, and
	// the filter bar's `flex-1` search box paid for it by sliding every control between them left by
	// a whole button width — a click aimed in that window hit the bar. jsdom has no layout, so this
	// measures what decides the width: the characters the pre-mount trigger lays out.
	it("holds the default label's width before mount, without naming it", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToString(
			<DateRangeFilter value={presetRange("7d")} onChange={() => {}} />,
		);
		const trigger = host.querySelector("button");
		if (!trigger) throw new Error("no trigger in the server HTML");
		// The widest line the trigger lays out before mount: the visible placeholder and any
		// invisible sizer share one grid cell, so the longer of them sets the width.
		const cells = [...trigger.querySelectorAll("span")].map((s) => s.textContent ?? "");
		const laidOut = Math.max(trigger.textContent?.length ?? 0, ...cells.map((c) => c.length));
		const label = formatRangeLabel(presetRange("7d"));
		expect(laidOut).toBeGreaterThanOrEqual(label.length - 2);
		// What a reader and the accessible name get is still only the placeholder.
		const named = [...trigger.querySelectorAll("span")].filter(
			(s) => !s.closest("[aria-hidden]") && s.querySelector("span") === null,
		);
		expect(named.map((s) => s.textContent).join("")).toBe("Date range");
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
		expect(formatInZone(range.from, TZ, "yyyy-MM-dd")).toBe("2026-06-01");
		expect(formatInZone(range.to, TZ, "yyyy-MM-dd")).toBe("2026-06-10");
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

// ── DST boundaries (#6142) ──────────────────────────────────────────────────────────────
//
// Every expected instant below is written by hand from the zone's published rules, NOT read
// back from the code under test:
//   Europe/Sofia      EET +02:00 / EEST +03:00. 2026: 03:00 → 04:00 on Sun Mar 29 (at 01:00Z),
//                     04:00 → 03:00 on Sun Oct 25 (at 01:00Z).
//   America/New_York  EST −05:00 / EDT −04:00. 2026: 02:00 → 03:00 on Sun Mar 8 (at 07:00Z),
//                     02:00 → 01:00 on Sun Nov 1 (at 06:00Z).
//   Asia/Kolkata      IST +05:30, no DST — the non-whole-hour offset.
// The non-DST rows are the cases where `date-fns-tz` (the old implementation) and these must
// agree; the gap/overlap rows are where the old one answered according to the HOST's zone.

const iso = (d: Date) => d.toISOString();

describe("zonedWallClockToInstant", () => {
	it.each([
		// Non-DST days: the old implementation's answers.
		["Europe/Sofia", "2026-06-15", "00:00", "2026-06-14T21:00:00.000Z"],
		["Europe/Sofia", "2026-06-15", "23:59", "2026-06-15T20:59:00.000Z"],
		["Europe/Sofia", "2026-01-15", "00:00", "2026-01-14T22:00:00.000Z"],
		["America/New_York", "2026-07-04", "00:00", "2026-07-04T04:00:00.000Z"],
		["America/New_York", "2026-01-15", "23:59", "2026-01-16T04:59:00.000Z"],
		["Asia/Kolkata", "2026-03-29", "00:00", "2026-03-28T18:30:00.000Z"],
		["Asia/Kolkata", "2026-10-25", "23:59", "2026-10-25T18:29:00.000Z"],
		["Asia/Kolkata", "2026-11-01", "12:00", "2026-11-01T06:30:00.000Z"],
		// Spring-forward day: start of day on the old offset, end of day on the new one.
		["Europe/Sofia", "2026-03-29", "00:00", "2026-03-28T22:00:00.000Z"],
		["Europe/Sofia", "2026-03-29", "23:59", "2026-03-29T20:59:00.000Z"],
		["America/New_York", "2026-03-08", "00:00", "2026-03-08T05:00:00.000Z"],
		["America/New_York", "2026-03-08", "23:59", "2026-03-09T03:59:00.000Z"],
		// Fall-back day: start of day on the summer offset, end of day on the winter one.
		["Europe/Sofia", "2026-10-25", "00:00", "2026-10-24T21:00:00.000Z"],
		["Europe/Sofia", "2026-10-25", "23:59", "2026-10-25T21:59:00.000Z"],
		["America/New_York", "2026-11-01", "00:00", "2026-11-01T04:00:00.000Z"],
		["America/New_York", "2026-11-01", "23:59", "2026-11-02T04:59:00.000Z"],
	])("%s %s %s → %s", (zone, date, time, expected) => {
		expect(iso(zonedWallClockToInstant(date, time, zone))).toBe(expected);
	});

	// A time the clocks skip does not exist; it moves forward by the gap (03:30 → 04:30 EEST,
	// 02:30 → 03:30 EDT), so the instant is never EARLIER than what the reader typed.
	it.each([
		["Europe/Sofia", "2026-03-29", "03:30", "2026-03-29T01:30:00.000Z"],
		["America/New_York", "2026-03-08", "02:30", "2026-03-08T07:30:00.000Z"],
	])("skipped %s %s %s → %s", (zone, date, time, expected) => {
		expect(iso(zonedWallClockToInstant(date, time, zone))).toBe(expected);
	});

	// A time the clocks repeat names two instants; the earlier (summer-time) one is taken.
	it.each([
		["Europe/Sofia", "2026-10-25", "03:30", "2026-10-25T00:30:00.000Z"],
		["America/New_York", "2026-11-01", "01:30", "2026-11-01T05:30:00.000Z"],
	])("repeated %s %s %s → %s", (zone, date, time, expected) => {
		expect(iso(zonedWallClockToInstant(date, time, zone))).toBe(expected);
	});

	it("is an invalid date for an unparseable wall-clock", () => {
		expect(Number.isNaN(zonedWallClockToInstant("", "00:00", "UTC").getTime())).toBe(true);
	});
});

describe("formatInZone / formatRangeLabel across DST", () => {
	it.each([
		// 00:30Z on Sofia's spring-forward day is still EET: 02:30, not 03:30.
		["2026-03-29T00:30:00.000Z", "Europe/Sofia", "2026-03-29 02:30"],
		["2026-03-29T01:30:00.000Z", "Europe/Sofia", "2026-03-29 04:30"],
		// The two 03:30s of Sofia's fall-back day.
		["2026-10-25T00:30:00.000Z", "Europe/Sofia", "2026-10-25 03:30"],
		["2026-10-25T01:30:00.000Z", "Europe/Sofia", "2026-10-25 03:30"],
		["2026-11-01T05:30:00.000Z", "America/New_York", "2026-11-01 01:30"],
		["2026-11-01T06:30:00.000Z", "America/New_York", "2026-11-01 01:30"],
		["2026-03-08T07:00:00.000Z", "America/New_York", "2026-03-08 03:00"],
		["2026-06-15T18:29:00.000Z", "Asia/Kolkata", "2026-06-15 23:59"],
		["2026-06-15T18:30:00.000Z", "Asia/Kolkata", "2026-06-16 00:00"],
	])("%s in %s reads %s", (instant, zone, expected) => {
		expect(formatInZone(new Date(instant), zone, "yyyy-MM-dd HH:mm")).toBe(expected);
	});

	it("labels a last-7-days window that spans spring-forward on each side's own offset", () => {
		const now = new Date("2026-03-30T09:00:00.000Z"); // 12:00 EEST
		const range = { from: new Date("2026-03-23T09:00:00.000Z"), to: now }; // 11:00 EET
		expect(formatRangeLabel(range, "Europe/Sofia", now)).toBe("Mar 23, 11am – Mar 30, 12pm");
	});

	it("labels a window that spans fall-back in New York", () => {
		const now = new Date("2026-11-03T17:00:00.000Z"); // 12:00 EST
		const range = { from: new Date("2026-10-27T16:00:00.000Z"), to: now }; // 12:00 EDT
		expect(formatRangeLabel(range, "America/New_York", now)).toBe("Oct 27, 12pm – Nov 3, 12pm");
	});

	it("labels a Kolkata day on its half-hour offset", () => {
		const now = new Date("2026-06-15T12:00:00.000Z");
		const range = {
			from: new Date("2026-06-14T18:30:00.000Z"), // 00:00 IST
			to: new Date("2026-06-15T18:29:00.000Z"), //   23:59 IST
		};
		expect(formatRangeLabel(range, "Asia/Kolkata", now)).toBe("Jun 15, 12am");
	});
});

// "today", "last 7 days" and custom ranges are resolved in the HOST's zone (date-fns local
// time), so each case pins the host zone with `vi.stubEnv("TZ", …)`: Node re-reads the zone
// whenever that variable is assigned, and `unstubAllEnvs` puts the original back.
describe("host-zone presets across DST", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("today on New York's spring-forward day starts at local midnight EST", () => {
		vi.stubEnv("TZ", "America/New_York");
		const now = new Date("2026-03-08T18:00:00.000Z"); // 14:00 EDT
		const r = parseRangeInput("today", now);
		expect(r && iso(r.from)).toBe("2026-03-08T05:00:00.000Z");
		expect(r && iso(r.to)).toBe("2026-03-08T18:00:00.000Z");
	});

	it("yesterday over New York's fall-back day is a 25-hour day", () => {
		vi.stubEnv("TZ", "America/New_York");
		const now = new Date("2026-11-02T17:00:00.000Z"); // 12:00 EST, Nov 2
		const r = parseRangeInput("yesterday", now);
		expect(r && iso(r.from)).toBe("2026-11-01T04:00:00.000Z");
		expect(r && iso(r.to)).toBe("2026-11-02T04:59:59.999Z");
	});

	it("last 7 days across spring-forward keeps the wall-clock, not 168 hours", () => {
		vi.stubEnv("TZ", "America/New_York");
		const now = new Date("2026-03-10T16:00:00.000Z"); // 12:00 EDT
		expect(iso(presetRange("7d", now).from)).toBe("2026-03-03T17:00:00.000Z"); // 12:00 EST
	});

	it("last 7 days across Sofia's fall-back keeps the wall-clock", () => {
		vi.stubEnv("TZ", "Europe/Sofia");
		const now = new Date("2026-10-27T10:00:00.000Z"); // 12:00 EET
		expect(iso(presetRange("7d", now).from)).toBe("2026-10-20T09:00:00.000Z"); // 12:00 EEST
	});

	it("a custom range ending on spring-forward day ends at that day's 23-hour mark", () => {
		vi.stubEnv("TZ", "America/New_York");
		const now = new Date("2026-03-10T16:00:00.000Z");
		const r = parseRangeInput("Mar 6 - Mar 8", now);
		expect(r && iso(r.from)).toBe("2026-03-06T05:00:00.000Z"); // 00:00 EST
		expect(r && iso(r.to)).toBe("2026-03-09T03:59:59.999Z"); // 23:59:59.999 EDT
	});

	it("today in Kolkata starts at the half-hour UTC instant", () => {
		vi.stubEnv("TZ", "Asia/Kolkata");
		const now = new Date("2026-03-29T12:00:00.000Z"); // 17:30 IST
		const r = parseRangeInput("today", now);
		expect(r && iso(r.from)).toBe("2026-03-28T18:30:00.000Z");
	});
});

describe("DateRangeFilter custom range across DST", () => {
	it("commits start/end of New York's spring-forward day in the picker's zone", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<DateRangeFilter
				value={{
					from: new Date("2026-03-01T05:00:00.000Z"),
					to: new Date("2026-03-02T05:00:00.000Z"),
				}}
				onChange={onChange}
				defaultTimeZone="America/New_York"
			/>,
		);
		await user.click(screen.getByRole("button", { name: /–|—/ }));
		const dates = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
		const times = document.querySelectorAll<HTMLInputElement>('input[type="time"]');
		fireEvent.change(dates[0], { target: { value: "2026-03-08" } });
		fireEvent.change(times[0], { target: { value: "00:00" } });
		fireEvent.change(dates[1], { target: { value: "2026-03-08" } });
		fireEvent.change(times[1], { target: { value: "23:59" } });
		await user.click(screen.getByRole("button", { name: /apply/i }));

		const [range] = onChange.mock.calls[0];
		expect(iso(range.from)).toBe("2026-03-08T05:00:00.000Z"); // 00:00 EST
		expect(iso(range.to)).toBe("2026-03-09T03:59:00.000Z"); // 23:59 EDT
	});
});
