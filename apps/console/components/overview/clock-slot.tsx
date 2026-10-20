"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { cn } from "@repo/ui/utils";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * Text that reads the clock or the browser's time zone ("3 minutes ago", "resets in 4 hr"),
 * rendered only after hydration, in a slot at least as wide as `sizer`.
 *
 * The overview's cards render on the server now (#6118), and the server's clock and zone are not
 * the browser's: printing either during the server render or the hydrating one is React #418, which
 * throws the page's server HTML away. So the text is blank until `useHydrated()` turns true, and an
 * invisible copy of the widest string it prints holds its width meanwhile, so nothing reflows when
 * it arrives a commit later — the jobs table's `ClockSlot` pattern (components/jobs/columns.tsx).
 *
 * The slot is a one-cell grid, so it is as wide as the WIDER of the sizer and the text: a text wider
 * than its sizer still widens the slot when it arrives. Each caller therefore passes the widest
 * string it normally prints — for `formatRelative`, "less than a minute ago", as the jobs table does
 * — and a rarer, wider string costs one reflow, not a clipped label.
 */
export function ClockSlot({
	sizer,
	className,
	render,
}: {
	/** The widest string `render` normally returns — the slot's width before the clock is read. */
	sizer: string;
	className?: string;
	/** Produces the text; called only after hydration, so it may read `Date.now()` and the zone. */
	render: () => ReactNode;
}) {
	const hydrated = useHydrated();
	return (
		<span className={cn("inline-grid whitespace-nowrap", className)}>
			<span aria-hidden className="invisible col-start-1 row-start-1">
				{sizer}
			</span>
			<span className="col-start-1 row-start-1">{hydrated ? render() : null}</span>
		</span>
	);
}
