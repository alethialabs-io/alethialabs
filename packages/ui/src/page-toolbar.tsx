// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { CountPill } from "./count-pill";
import { cn } from "./utils";

/**
 * The slim row a console page opens with: its result count, one line of supporting copy, and its
 * actions. NO HEADING.
 *
 * This is what is left of `PageHeader` after the console lost its page titles. The name of the
 * page was said three times — the sidebar entry you clicked, the breadcrumb above the content, and
 * the page's own `<h1>` — and the third one earned nothing; Vercel's console does not have one, it
 * loads the page. But the old component was never only a title: it also carried the description,
 * the {@link CountPill} and the page's primary buttons, and the breadcrumb duplicates NONE of
 * those. So the heading text goes and this row survives, named for what it does.
 *
 * `count` renders through {@link CountPill}, which is where the console filter standard requires a
 * result count to live (`apps/console/lib/query/README.md`) — beside the heading rather than as
 * "N of M" prose in the filter bar. With the heading gone, this row IS that place, and it is why
 * the count did not simply move into the bar.
 *
 * A heading INSIDE a page is a different, smaller thing and is not this component: use
 * `SectionHeading` from `@repo/ui/section-heading`. `PageHeader`'s `level` prop was the wrong
 * answer to that — it rendered `text-lg font-medium` whatever the level, so every section heading
 * converted to it jumped to 18px from the 14.5–15px the console actually typesets that rung at.
 */
function PageToolbar({
	description,
	count,
	actions,
	className,
	...props
}: React.ComponentProps<"div"> & {
	/** One line of supporting copy. Omit rather than restating what the breadcrumb already says. */
	description?: React.ReactNode;
	/** Result count for a filtered list; null/undefined while loading renders nothing. */
	count?: number | null;
	/** Buttons for this page. Right-aligned, and they wrap under the row on narrow screens. */
	actions?: React.ReactNode;
}) {
	// Nothing to show is not an empty row: with no count, no copy and no actions this component
	// would otherwise render a bare flex container that still spends the page's vertical gap. A
	// page whose toolbar is empty should look like a page with no toolbar.
	const hasCount = typeof count === "number";
	if (!hasCount && description === undefined && actions === undefined) return null;
	return (
		<div
			data-slot="page-toolbar"
			className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}
			{...props}
		>
			<div className="flex min-w-0 flex-col gap-1">
				{hasCount ? <CountPill count={count} /> : null}
				{description ? (
					<p data-slot="page-toolbar-description" className="text-ui-md text-text-tertiary">
						{description}
					</p>
				) : null}
			</div>
			{actions ? (
				<div data-slot="page-toolbar-actions" className="flex shrink-0 items-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	);
}

export { PageToolbar };
