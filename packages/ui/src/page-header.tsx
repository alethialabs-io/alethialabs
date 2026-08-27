// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { CountPill } from "./count-pill";
import { cn } from "./utils";

/**
 * The title row every list and detail page opens with.
 *
 * There was no shared page header in the console: roughly thirty-seven authed pages each
 * hand-wrote a title, an optional description and an actions row, so the type scale, the gap and
 * the vertical rhythm drifted page to page. The only abstraction was a file-local `SectionHeader`
 * private to the alerts page.
 *
 * `count` renders through {@link CountPill} beside the title, which is where the console filter
 * standard requires result counts to live.
 */
function PageHeader({
	title,
	description,
	count,
	actions,
	level = 1,
	className,
	...props
}: Omit<React.ComponentProps<"div">, "title"> & {
	/** The page name. Rendered as the heading, so pass text, not a node with its own heading. */
	title: React.ReactNode;
	/** One line of supporting copy. Omit rather than repeating the title. */
	description?: React.ReactNode;
	/** Result count for a filtered list; null/undefined while loading renders nothing. */
	count?: number | null;
	/** Buttons for this page. Right-aligned, and they wrap under the title on narrow screens. */
	actions?: React.ReactNode;
	/**
	 * Heading level. `1` for the page's own title; `2`/`3` for a section heading on a page that
	 * already has one.
	 *
	 * This is a prop rather than a fixed `<h1>` because the first version WAS fixed, and three
	 * lanes hit it within an hour: the alerts hub stacks three of these on one route and would
	 * have rendered three `<h1>`s, and the evidence page declined to adopt the component at all
	 * rather than give itself a second one. A consumer cannot fix a hardcoded tag, so it stopped
	 * being the component's decision.
	 *
	 * The visual size does NOT change with the level — a section heading here is still a section
	 * heading, and tying type scale to document outline is how headings get chosen for their looks.
	 */
	level?: 1 | 2 | 3;
}) {
	const Heading = `h${level}` as const;
	return (
		<div
			data-slot="page-header"
			className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}
			{...props}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex items-center gap-2">
					<Heading data-slot="page-header-title" className="truncate text-lg font-medium tracking-tight">
						{title}
					</Heading>
					<CountPill count={count} />
				</div>
				{description ? (
					<p data-slot="page-header-description" className="text-sm text-text-tertiary">
						{description}
					</p>
				) : null}
			</div>
			{actions ? (
				<div data-slot="page-header-actions" className="flex shrink-0 items-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	);
}

export { PageHeader };
