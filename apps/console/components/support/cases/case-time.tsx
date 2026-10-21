"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate, formatRelative } from "@repo/format";
import { cn } from "@repo/ui/utils";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * A support timestamp that reads the clock or the browser's time zone — and therefore cannot be
 * rendered on the server and agree with the browser. Until hydration is over it renders an
 * invisible sizer of the same shape instead, so the server HTML and the hydrating render match
 * (no React #418) and the line does not reflow when the text arrives a commit later: the sizer and
 * the text share one grid cell and the wider sets the width (the `ClockSlot` pattern in
 * `components/jobs/columns.tsx`).
 *
 * `relative` reads "3 minutes ago"; `date` and `datetime` are absolute, in the viewer's zone.
 */
export function CaseTime({
	value,
	style,
	className,
}: {
	value: Date | string;
	style: "relative" | "date" | "datetime";
	className?: string;
}) {
	const hydrated = useHydrated();
	const sizer = SIZERS[style];
	const text = style === "relative" ? formatRelative(value) : formatDate(value, style);
	return (
		<span className={cn("inline-grid whitespace-nowrap", className)}>
			<span aria-hidden className="invisible col-start-1 row-start-1">
				{sizer}
			</span>
			<time
				dateTime={new Date(value).toISOString()}
				className="col-start-1 row-start-1"
			>
				{hydrated ? text : null}
			</time>
		</span>
	);
}

/** A typical rendering of each style — what the slot reserves before the real text exists. */
const SIZERS: Record<"relative" | "date" | "datetime", string> = {
	relative: "about 2 hours ago",
	date: "Oct 20, 2026",
	datetime: "Oct 20, 2026, 08:00 AM",
};
