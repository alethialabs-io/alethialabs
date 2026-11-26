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
 *
 * The module kept its name when `CountPill`, the heading form of this figure, was deleted with the
 * console's list counts (LST-14, #7496): the module path is what five filter primitives import.
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
 * The accessible name of a row that trails a {@link CountFigure}: its label, then each trailing
 * figure, comma-separated — `"Built-in, 4"`, `"Alice, alice@acme.io, 12"`.
 *
 * Computed from contents, a row reads its spans run together (`"Built-in4"`), because the gap
 * between the label and the figure is layout rather than text. And a figure dropped from the name
 * is a count a screen-reader user never hears (#6734). Empty and absent parts are skipped, so a row
 * with neither a hint nor a count is named by its label alone.
 */
function rowAccessibleName(label: string, ...trailing: Array<string | number | null | undefined>): string {
	return [label, ...trailing.filter((t) => t !== undefined && t !== null && t !== "").map(String)].join(", ");
}

export { CountFigure, rowAccessibleName };
