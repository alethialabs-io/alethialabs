// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared presentational primitives for the Usage surfaces (org + project panels). Pure,
// dependency-free cells so the two panels render identically — promoted here rather than
// duplicated per panel.

import type { ReactNode } from "react";

/** One usage meter cell (key, value, fill %, sub note). */
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
				<span className="text-[12.5px] text-text-secondary">{value}</span>
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

/** One fact: a term, its value, and an optional qualifier on the term. */
export function Fact({
	label,
	value,
	sub,
}: {
	label: string;
	value: ReactNode;
	/** What the value is OF — a time window, a scope note. Reads after the label. */
	sub?: ReactNode;
}) {
	return (
		<div className="flex items-baseline justify-between gap-4 border-b border-border px-6 py-[11px] last:border-b-0">
			<dt className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12.5px] text-text-secondary">
				{label}
				{sub && (
					<span className="font-mono text-[10px] text-text-tertiary">{sub}</span>
				)}
			</dt>
			<dd className="shrink-0 font-mono text-[12.5px] text-text-primary">{value}</dd>
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
