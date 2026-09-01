// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared presentational primitives for the Usage surfaces (org + project panels). Pure,
// dependency-free cells so the two panels render identically — promoted here rather than
// duplicated per panel.

import type { ReactNode } from "react";
import { cn } from "@repo/ui/utils";

/**
 * One usage meter cell (key, value, fill %, sub note).
 *
 * THE CELL OWNS THE VALUE'S WEIGHT, and the call sites do not. They used to: two of the three
 * meters in the Plan-&-limits row wrapped their numerator in a local `<b>` and left the
 * denominator lighter, while the third — runner minutes, whose pair comes from `formatQuota` as
 * one string and cannot be split without re-assembling the pair that helper exists to prevent —
 * had no way to match. Three cells in one row, two renderings of one shape of fact. So the
 * emphasis moved here, where there is only one of it: the whole quantity reads as one quantity.
 */
export function Meter({
	label,
	value,
	sub,
	fill,
}: {
	label: string;
	value: ReactNode;
	sub: ReactNode;
	/** 0–100 fill percentage. */
	fill: number;
}) {
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
					{label}
				</span>
				<span className="text-[12.5px] font-medium text-text-primary">{value}</span>
			</div>
			<div className="h-[5px] overflow-hidden rounded-full border border-border bg-surface-sunken">
				<div
					className="h-full rounded-full bg-text-primary"
					style={{ width: `${Math.min(100, Math.max(0, fill))}%` }}
				/>
			</div>
			<div className="mt-2 font-mono text-[10px] text-text-tertiary">{sub}</div>
		</div>
	);
}

/**
 * A list of facts about what a scope currently runs. Renders a `<dl>`; put {@link Fact} in it.
 *
 * This replaces the `Stat` card and the `grid grid-cols-2 sm:grid-cols-4` strip both usage
 * panels used to head their cards with. §6 bans stat-card strips with no qualifier, and the
 * Resources card was the argument for the ban in miniature: three 20px display figures across
 * the top, and then the number that actually costs somebody money — estimated cloud spend — as
 * a quiet label-and-value line at the bottom of the same card. Two renderings of the same kind
 * of fact, one card, and the loud one was the one that mattered least.
 *
 * So the card keeps the quiet shape and drops the loud one. A count is now read the way the
 * spend line was always read, and a `<dl>` says in the accessibility tree what the old grid of
 * divs only said in pixels: these are terms and their values.
 */
export function FactList({ children }: { children: ReactNode }) {
	return <dl>{children}</dl>;
}

/**
 * One fact: a term on the left, its value on the right, and an optional qualifier ON THE VALUE.
 *
 * `sub` belongs to the `<dd>` and never to the `<dt>`, and the difference is not cosmetic:
 * assistive tech reads a `<dt>` as ONE label, so putting the qualifier there made the term for
 * `5h 20m` read "Runner job-minutes 12 managed jobs this period" — a label containing a second,
 * unrelated measurement — and made `AI credits used *` carry a footnote marker whose footnote
 * lives outside the list. The qualifier says what the VALUE is of, so it is part of the value.
 */
export function Fact({
	label,
	value,
	sub,
	icon,
	className,
}: {
	label: string;
	value: ReactNode;
	/** What the VALUE is of — a time window, a scope note, a footnote marker. */
	sub?: ReactNode;
	/** A leading glyph on the term, for a fact the card marks as an estimate. */
	icon?: ReactNode;
	/** Row treatment, for the estimate row that closes a card. */
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-baseline justify-between gap-4 border-b border-border px-6 py-[11px] last:border-b-0",
				className,
			)}
		>
			<dt className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-text-secondary">
				{icon}
				<span className="min-w-0">{label}</span>
			</dt>
			<dd className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2 text-[12.5px]">
				{sub && (
					<span className="font-mono text-[10px] text-text-tertiary">{sub}</span>
				)}
				<span className="font-mono text-text-primary">{value}</span>
			</dd>
		</div>
	);
}

/**
 * A lightweight CSS bar chart for one over-time metric (no chart dependency). Generic over
 * any day-keyed point so the org and project over-time series both render through it.
 */
export function Bars<T extends { date: string }>({
	points,
	pick,
}: {
	points: T[];
	pick: (p: T) => number;
}) {
	const max = Math.max(1, ...points.map(pick));
	return (
		<div className="flex h-28 items-end gap-px">
			{points.map((p) => {
				const v = pick(p);
				return (
					<div
						key={p.date}
						title={`${p.date}: ${v.toLocaleString()}`}
						className="min-w-[2px] flex-1 rounded-t-[1px] bg-text-primary/80 transition-colors hover:bg-text-primary"
						style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
					/>
				);
			})}
		</div>
	);
}
