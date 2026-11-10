"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate, formatRelative } from "@repo/format";
import { useHydrated } from "@repo/ui/use-hydrated";

/** How a case timestamp reads: relative to now, or an absolute date with or without the time. */
export type CaseTimeStyle = "relative" | "date" | "datetime";

/**
 * The widest string each style prints, so the slot holds that width before the text arrives.
 * `en-GB` abbreviates September to four letters, which is why the absolute sizers name it.
 */
const SIZER: Record<CaseTimeStyle, string> = {
	relative: "less than a minute ago",
	date: "30 Sept 2026",
	datetime: "30 Sept 2026, 23:59",
};

/** Renders one case timestamp through `@repo/format`. */
function formatCaseTime(instant: Date, style: CaseTimeStyle): string {
	return style === "relative" ? formatRelative(instant) : formatDate(instant, style);
}

/**
 * A support-case timestamp that is safe to server-render.
 *
 * Every case surface in this app is prefetched on the server and hydrated, and each style here
 * reads something the server and the browser disagree on: `relative` reads the clock, and the
 * absolute styles read the runtime's time zone (the server's on the server, the staff member's in
 * the browser). Rendering either during hydration is React #418. So the text is left blank until
 * hydration is over, inside a slot already as wide as the widest string the style prints, and the
 * `<time>` element carries the instant for assistive tech meanwhile.
 *
 * The hydration test is `useHydrated()` from `@repo/ui/use-hydrated`, shared with the console.
 */
export function CaseTime({ at, style }: { at: string | Date; style: CaseTimeStyle }) {
	const hydrated = useHydrated();
	const instant = new Date(at);
	// A value that is not a date must not take the row down: `toISOString()` throws on it, and
	// `@repo/format` already answers an em dash, which needs neither the clock nor the zone.
	if (Number.isNaN(instant.getTime())) return <span>{formatRelative(null)}</span>;
	return (
		<time dateTime={instant.toISOString()} className="inline-grid whitespace-nowrap">
			<span aria-hidden className="invisible col-start-1 row-start-1">
				{SIZER[style]}
			</span>
			<span className="col-start-1 row-start-1">
				{hydrated ? formatCaseTime(instant, style) : null}
			</span>
		</time>
	);
}
