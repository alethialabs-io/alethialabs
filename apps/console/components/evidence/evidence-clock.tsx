"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Relative times on the Evidence surface ("2 days ago"), read against the BROWSER's clock only once
// the page has hydrated. The rows are server-rendered now (#6126), and a string computed from the
// server's clock and again from the browser's can differ — at a minute or day boundary, or under
// clock skew — which React reports as #418 and answers by throwing the server HTML away. Until
// hydration the slot is blank but already as wide as its widest string, so nothing reflows when the
// text arrives a commit later (the invisible-sizer pattern `components/jobs/columns.tsx` uses).

import { formatRelative } from "@repo/format";
import { cn } from "@repo/ui/utils";
import type { ReactNode } from "react";
import { useHydrated } from "@/hooks/use-hydrated";

/** The widest relative string `formatRelative` prints for a proof timestamp. */
const RELATIVE_SIZER = "less than a minute ago";

/**
 * `at` as a relative time (or "—" when there is none), blank until hydration. `prefix` is prepended
 * to the text (e.g. "Expires "); `children` render beside it, also only after hydration — for marks
 * that are themselves derived from the clock (the staleness glyph).
 */
export function RelativeClock({
	at,
	prefix = "",
	className,
	children,
}: {
	at: string | null;
	prefix?: string;
	className?: string;
	children?: ReactNode;
}) {
	const hydrated = useHydrated();
	return (
		<span className={cn("inline-grid whitespace-nowrap", className)}>
			<span aria-hidden className="invisible col-start-1 row-start-1">
				{prefix}
				{RELATIVE_SIZER}
			</span>
			<span className="col-start-1 row-start-1 inline-flex items-center gap-1.5">
				{hydrated ? (
					<>
						{children}
						{at ? `${prefix}${formatRelative(at)}` : formatRelative(null)}
					</>
				) : null}
			</span>
		</span>
	);
}
