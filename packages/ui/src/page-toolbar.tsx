// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { Skeleton } from "./skeleton";
import { cn } from "./utils";

// The row's three layout class lists, shared by `PageToolbar` and `PageToolbarSkeleton` so the
// skeleton cannot drift from the row it stands in for. A skeleton that is a few pixels off is
// a layout shift the moment the data lands, which is the one thing it exists to prevent.
const ROW = "flex flex-wrap items-start justify-between gap-x-4 gap-y-2";
// `items-start` (#6117, F016): a flex COLUMN stretches its children across its width by default.
// The count pill that once sat here grew to the width of the description beside it that way; the
// pill is gone (LST-14, #7496), and start alignment keeps whatever the column holds content-sized.
const LEAD = "flex min-w-0 flex-col items-start gap-1";
// `text-ui-md` (13px), down from `PageHeader`'s `text-sm` (14px), and it is a ROLE choice rather
// than a derived one — the ladder's bands were measured over `text-[Npx]` sites, and `text-sm` is
// a Tailwind utility that was in none of them. The band containing 14px is `--text-ui-lg`, which
// is the SECTION-HEADING rung: a description typeset at 15px would be the same size as the heading
// it sits under. 13px is the body rung, and supporting copy is body.
const DESCRIPTION = "text-ui-md text-text-tertiary";
const ACTIONS = "flex shrink-0 items-center gap-2";

/**
 * The slim row a console page opens with: one line of supporting copy and its actions. NO HEADING,
 * and NO COUNT.
 *
 * This is what is left of `PageHeader` after the console lost its page titles. The name of the
 * page was said three times — the sidebar entry you clicked, the breadcrumb above the content, and
 * the page's own `<h1>` — and the third one earned nothing; Vercel's console does not have one, it
 * loads the page. But the old component was never only a title: it also carried the description,
 * a count pill and the page's primary buttons, and the breadcrumb duplicates NONE of those. So the
 * heading text goes and this row survives, named for what it does.
 *
 * It has no `count` prop. It had one until LST-14 (#7496): the console carries no list counts
 * (epic #7481 — a list's size is its rows, each marked `data-list-item`, and totals exist only as
 * facet option counts), so a result count has nowhere to live, here or in the filter bar.
 *
 * A heading INSIDE a page is a different, smaller thing and is not this component: use
 * `SectionHeading` from `@repo/ui/section-heading`. `PageHeader`'s `level` prop was the wrong
 * answer to that — it rendered `text-lg font-medium` whatever the level, so every section heading
 * converted to it jumped to 18px from the 14.5–15px the console actually typesets that rung at.
 */
function PageToolbar({
	description,
	actions,
	className,
	...props
	// `Omit<…, "title">` is the load-bearing half of this signature, not tidiness. `title` is a
	// valid `<div>` attribute, so without it `<PageToolbar title="Connectors" …>` — the exact
	// shape 19 files were hand-edited to remove — compiles clean, renders NO heading, and hangs
	// the page's name off the row as a hover tooltip. `tsc` would not see it and
	// `check-shared-surface` matches `<h1`, not this. With the Omit it is a compile error.
}: Omit<React.ComponentProps<"div">, "title"> & {
	/** One line of supporting copy. Omit rather than restating what the breadcrumb already says. */
	description?: React.ReactNode;
	/** Buttons for this page. Right-aligned, and they wrap under the row on narrow screens. */
	actions?: React.ReactNode;
}) {
	// Nothing to show is not an empty row: with no copy and no actions this component would
	// otherwise render a bare flex container that still spends the page's vertical gap. A page
	// whose toolbar is empty should look like a page with no toolbar.
	if (description === undefined && actions === undefined) return null;
	return (
		<div
			data-slot="page-toolbar"
			className={cn(ROW, className)}
			{...props}
		>
			<div data-slot="page-toolbar-lead" className={LEAD}>
				{description ? (
					<p data-slot="page-toolbar-description" className={DESCRIPTION}>
						{description}
					</p>
				) : null}
			</div>
			{actions ? (
				<div data-slot="page-toolbar-actions" className={ACTIONS}>
					{actions}
				</div>
			) : null}
		</div>
	);
}

/**
 * The loading form of {@link PageToolbar}: the same row, with placeholders where the description
 * and the actions will be. Use it in a route's `loading.tsx` or a pending branch, in
 * the place the page renders its `PageToolbar`.
 *
 * Say which parts the real toolbar has, so the placeholder takes exactly the space the content
 * will. The description is sized BY CONSTRUCTION rather than by a guessed height: it is a line of
 * transparent text in the description's own type, so it is as tall as what replaces it in every
 * theme and at every rung. The actions are `size="sm"` buttons, which is what every console toolbar renders.
 *
 * Like `PageToolbar`, it renders nothing when it is asked for nothing.
 *
 * @example
 * <PageToolbarSkeleton actions={1} />
 */
function PageToolbarSkeleton({
	description = true,
	actions = 0,
	className,
}: {
	/** The real toolbar shows a line of supporting copy. Defaults to true. */
	description?: boolean;
	/** How many action buttons the real toolbar shows. */
	actions?: number;
	className?: string;
}) {
	if (!description && actions <= 0) return null;
	return (
		<div
			data-slot="page-toolbar-skeleton"
			aria-hidden
			className={cn(ROW, className)}
		>
			<div className={LEAD}>
				{description ? (
					<p className={cn(DESCRIPTION, "text-transparent")}>
						<span className="animate-pulse rounded-md bg-accent">
							{"\u00a0".repeat(48)}
						</span>
					</p>
				) : null}
			</div>
			{actions > 0 ? (
				<div className={ACTIONS}>
					{Array.from({ length: actions }, (_, i) => (
						<Skeleton key={i} className="h-8 w-24 rounded-none" />
					))}
				</div>
			) : null}
		</div>
	);
}

export { PageToolbar, PageToolbarSkeleton };
