// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { CountPill } from "./count-pill";
import { Skeleton } from "./skeleton";
import { cn } from "./utils";

// The row's three layout class lists, shared by `PageToolbar` and `PageToolbarSkeleton` so the
// skeleton cannot drift from the row it stands in for. A skeleton that is a few pixels off is
// a layout shift the moment the data lands, which is the one thing it exists to prevent.
const ROW = "flex flex-wrap items-start justify-between gap-x-4 gap-y-2";
// `items-start` is load-bearing (#6117, F016). A flex COLUMN stretches its children across its
// width by default, so the `CountPill` — `inline-flex`, but a flex item all the same — grew to the
// width of the description beside it, ~300px with the number in its far-left corner. That read
// as a skeleton stuck on every list page. Start-aligned, the pill is sized to its content.
const LEAD = "flex min-w-0 flex-col items-start gap-1";
// `text-ui-md` (13px), down from `PageHeader`'s `text-sm` (14px), and it is a ROLE choice rather
// than a derived one — the ladder's bands were measured over `text-[Npx]` sites, and `text-sm` is
// a Tailwind utility that was in none of them. The band containing 14px is `--text-ui-lg`, which
// is the SECTION-HEADING rung: a description typeset at 15px would be the same size as the heading
// it sits under. 13px is the body rung, and supporting copy is body.
const DESCRIPTION = "text-ui-md text-text-tertiary";
const ACTIONS = "flex shrink-0 items-center gap-2";

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
	// `Omit<…, "title">` is the load-bearing half of this signature, not tidiness. `title` is a
	// valid `<div>` attribute, so without it `<PageToolbar title="Connectors" …>` — the exact
	// shape 19 files were hand-edited to remove — compiles clean, renders NO heading, and hangs
	// the page's name off the row as a hover tooltip. `tsc` would not see it and
	// `check-shared-surface` matches `<h1`, not this. With the Omit it is a compile error.
}: Omit<React.ComponentProps<"div">, "title"> & {
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
			className={cn(ROW, className)}
			{...props}
		>
			<div data-slot="page-toolbar-lead" className={LEAD}>
				{hasCount ? <CountPill count={count} /> : null}
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
 * The loading form of {@link PageToolbar}: the same row, with placeholders where the count, the
 * description and the actions will be. Use it in a route's `loading.tsx` or a pending branch, in
 * the place the page renders its `PageToolbar`.
 *
 * Say which parts the real toolbar has, so the placeholder takes exactly the space the content
 * will. The pieces are sized BY CONSTRUCTION rather than by guessed heights: the count is a real
 * `CountPill` with its figure made transparent, and the description is a line of transparent text
 * in the description's own type, so both are as tall as what replaces them in every theme and at
 * every rung. The actions are `size="sm"` buttons, which is what every console toolbar renders.
 *
 * Like `PageToolbar`, it renders nothing when it is asked for nothing.
 *
 * @example
 * <PageToolbarSkeleton count actions={1} />
 */
function PageToolbarSkeleton({
	count = false,
	description = true,
	actions = 0,
	className,
}: {
	/** The real toolbar shows a result count. */
	count?: boolean;
	/** The real toolbar shows a line of supporting copy. Defaults to true. */
	description?: boolean;
	/** How many action buttons the real toolbar shows. */
	actions?: number;
	className?: string;
}) {
	if (!count && !description && actions <= 0) return null;
	return (
		<div
			data-slot="page-toolbar-skeleton"
			aria-hidden
			className={cn(ROW, className)}
		>
			<div className={LEAD}>
				{count ? (
					<CountPill count={0} className="animate-pulse bg-accent text-transparent" />
				) : null}
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
