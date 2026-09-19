// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { cn } from "./utils";

/**
 * A trailing mono figure — the count that follows a label.
 *
 * ONE element, because there were four. `FilterChip`, `FacetFilter`, `MultiCombobox` and
 * `FunnelFilter` each rendered "a facet count after a label" independently, and the alerts and
 * connectors bars mount three of them side by side — so the same figure appeared at 10px, 10.5px
 * and 11px, in two different ink tiers, on one screen (#4309). Two of those were `text-[10.5px]`
 * literals that the console's font-size guard cannot reach, because they live in this package.
 *
 * The converged spec is the mono voice at the `--text-ui-2xs` rung — the 10–10.5px band's own rung
 * — in `--text-tertiary` at FULL STRENGTH, with `tabular-nums` so a column of counts does not
 * jitter. Full strength is the whole point: every one of the four had reached for an alpha or a
 * near-tier at some stage, and an alpha over ink is a fifth tier nobody named (at α=0.6 over the
 * page the darkest reachable ink is 2.9:1, #4197).
 *
 * It takes `children` rather than a number because two of its four callers pass `hint`, which is a
 * string and is not always a count — an email in the members combobox, a short job id in the
 * command palette. The role is the same: a quiet mono figure trailing a label.
 *
 * Override the tier through `className` when the element is on inverted ink — see `FilterChip`,
 * whose filled state passes `text-inherit` — and see the token gap recorded there.
 */
function CountFigure({ className, children, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="count-figure"
			className={cn("font-mono text-ui-2xs text-text-tertiary tabular-nums", className)}
			{...props}
		>
			{children}
		</span>
	);
}

/**
 * The mono count that sits beside a section heading.
 *
 * `apps/console/lib/query/README.md` has required this since the filter standard was written —
 * "Result counts live in the count pill next to the section heading — never 'N of M' prose in the
 * bar" — but no component backed it, so the one implementation lived privately inside an agent
 * panel and every other page wrote prose instead.
 *
 * The HEADING form of {@link CountFigure}: the same mono tertiary figure, one rung larger and set
 * in a `--surface-muted` chip, because beside a heading it is a labelled quantity rather than a
 * column of trailing counts.
 *
 * Renders nothing when `count` is null or undefined, so a page can pass a still-loading query
 * result straight through without a ternary at the call site. A count of `0` DOES render: "0" is
 * a result, and hiding it is how an empty filtered list comes to look like a broken one.
 */
function CountPill({
	count,
	className,
	...props
}: React.ComponentProps<"span"> & { count: number | null | undefined }) {
	if (count === null || count === undefined) return null;
	return (
		<CountFigure
			data-slot="count-pill"
			className={cn(
				"inline-flex items-center rounded-sm bg-surface-muted px-1.5 py-0.5 text-ui-xs leading-none",
				className,
			)}
			{...props}
		>
			{count.toLocaleString()}
		</CountFigure>
	);
}

export { CountFigure, CountPill };
