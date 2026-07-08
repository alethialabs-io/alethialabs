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

/** A compact resource stat (count + label + optional sub). */
export function Stat({
	label,
	value,
	sub,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
}) {
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
				{label}
			</div>
			<div className="mt-1.5 font-display text-[20px] font-semibold tracking-[-0.02em] text-text-primary">
				{value}
			</div>
			{sub && <div className="mt-0.5 font-mono text-[10px] text-text-tertiary">{sub}</div>}
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
