// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A list page's time-window choice as ONE filter value (#6731, #6740). A date choice used to be
// stored as three keys (absolute `from` and `to`, plus a relative `rangeLabel`). Picking "Last 14
// days" therefore wrote a fixed window under a relative name: a link opened next month still said
// "Last 14 days" over the old dates. The single choice also counted as 3 on "Reset · N". The value
// is now exactly one of:
//
//   ""             the page's default window (each page says what that is: invoices = all time,
//                  activity = the default preset, open-ended).
//   a preset id    "30d": relative, and it STAYS relative. The read resolves it at read time.
//   "<from>/<to>"  an explicit window from the date picker (ISO 8601 interval notation).
//
// Pure, with no React and no server imports, so a route's server component and the browser decode
// a link identically.

import { JOBS_RANGE_PRESETS } from "@/lib/rpc/inputs/jobs";
import { type DateRange, RANGE_PRESETS } from "@repo/ui/range";

/** A relative window, by its quick-range preset id (`@repo/ui/range` RANGE_PRESETS). */
export type RangePresetId = (typeof JOBS_RANGE_PRESETS)[number];

/** The decoded time-window choice. */
export type RangeFilter =
	| { kind: "default" }
	| { kind: "preset"; preset: RangePresetId }
	| { kind: "window"; from: string; to: string };

/** The quick-range trigger's label while an explicit window is set (the date picker shows it). */
export const CUSTOM_RANGE_LABEL = "Custom range";

/** Separates an explicit window's two bounds (ISO 8601 interval). */
const WINDOW_SEPARATOR = "/";

/** Type guard: a string is one of the relative presets a read resolves. */
export function isRangePresetId(s: string): s is RangePresetId {
	return JOBS_RANGE_PRESETS.some((p) => p === s);
}

/** An ISO instant normalized to `toISOString()`, or null when the text is not a date. */
function isoInstant(text: string): string | null {
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** An explicit window from two ISO bounds (in either order), or null when either is not a date. */
export function windowFilter(
	fromText: string,
	toText: string,
): Extract<RangeFilter, { kind: "window" }> | null {
	const from = isoInstant(fromText);
	const to = isoInstant(toText);
	if (from === null || to === null) return null;
	return from <= to ? { kind: "window", from, to } : { kind: "window", from: to, to: from };
}

/**
 * Decode a range value. Anything unrecognised, such as a hand-edited link, decodes as the page's
 * default rather than as a window nobody chose.
 */
export function parseRangeFilter(value: string): RangeFilter {
	if (value === "") return { kind: "default" };
	if (isRangePresetId(value)) return { kind: "preset", preset: value };
	const parts = value.split(WINDOW_SEPARATOR);
	if (parts.length !== 2) return { kind: "default" };
	return windowFilter(parts[0] ?? "", parts[1] ?? "") ?? { kind: "default" };
}

/** Encode an explicit window as a range value. */
export function rangeWindowValue(window: DateRange): string {
	return `${window.from.toISOString()}${WINDOW_SEPARATOR}${window.to.toISOString()}`;
}

/**
 * The range value for a quick-range pick. A preset stays its id, so it round-trips as relative.
 * Anything typed ("10d", "yesterday") is resolved now into an explicit window, which is what it is.
 */
export function rangeFromPick(window: DateRange, label: string): string {
	const preset = RANGE_PRESETS.find((p) => p.label === label)?.id;
	return preset !== undefined && isRangePresetId(preset) ? preset : rangeWindowValue(window);
}

/** What the quick-range trigger says. A fixed window never gets a relative name. */
export function rangeFilterLabel(range: RangeFilter, defaultLabel: string): string {
	switch (range.kind) {
		case "default":
			return defaultLabel;
		case "preset":
			return RANGE_PRESETS.find((p) => p.id === range.preset)?.label ?? CUSTOM_RANGE_LABEL;
		case "window":
			return CUSTOM_RANGE_LABEL;
	}
}
