"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@repo/ui/utils";

/**
 * Text that reads the CLOCK or the BROWSER'S TIME ZONE — a period end, "resets in 3h", "Renews
 * Oct 31" — rendered only once hydration is over, in a slot that already has its width.
 *
 * The billing and usage pages are server-rendered with their data since #6127. The server formats
 * in its own zone (UTC) at its own instant; the browser formats in the viewer's zone at a later one.
 * Printing either during hydration is a text mismatch — React #418 — and React throws the page's
 * server HTML away (the release gate's qa leg caught exactly this once). So the text is computed
 * after hydration (`useHydrated`), and an invisible `sizer` holds its width meanwhile so nothing
 * beside it moves when it arrives (the jobs table's `ClockSlot` shape, #5849).
 *
 * `text` is a FUNCTION so the clock is not even read on the server or the hydrating render.
 */
export function ClockText({
	text,
	sizer,
	className,
}: {
	text: () => string;
	/** The widest string `text` prints, to reserve its width before the first client render. */
	sizer: string;
	className?: string;
}) {
	const hydrated = useHydrated();
	// The sizer is GENERATED CONTENT (`::before` from `data-sizer`), not a DOM node. As a hidden
	// `<span>` it carried the same words as the text, so a text query — the release gate's qa leg's
	// `getByText(/^Resets /)` — resolved to the invisible copy first. Generated content holds the
	// width in the same grid cell and is not text in the document.
	return (
		<span
			data-sizer={sizer}
			className={cn(
				"inline-grid whitespace-nowrap before:invisible before:col-start-1 before:row-start-1 before:content-[attr(data-sizer)]",
				className,
			)}
		>
			<span className="col-start-1 row-start-1">{hydrated ? text() : null}</span>
		</span>
	);
}
