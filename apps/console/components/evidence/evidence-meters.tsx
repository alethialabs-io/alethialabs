// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The three headline distribution meters (Verify / Drift / Security) — a compact proof
// roll-up for the whole org. Each is a big count over a segmented bar + a counted legend.

import { cn } from "@repo/ui/utils";
import type { Meter } from "./evidence-derive";
import { TONE_BAR } from "./evidence-status";

/** One distribution meter card: headline count, segmented bar, and a counted legend. */
function MeterCard({ meter }: { meter: Meter }) {
	const total = meter.segments.reduce((n, s) => n + s.count, 0);
	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-surface p-4 shadow-sm">
			<div className="flex items-baseline justify-between gap-2">
				<span className="font-mono text-[10px] uppercase tracking-[0.17em] text-text-tertiary">
					{meter.title}
				</span>
				<span className="font-mono text-[10px] text-text-disabled">
					{meter.scope}
				</span>
			</div>
			<div className="flex items-baseline gap-2">
				<span className="font-display text-3xl font-semibold leading-none tracking-tight tabular-nums text-text-primary">
					{meter.headNum}
				</span>
				<span className="font-mono text-[11px] text-text-tertiary">
					{meter.headLabel}
				</span>
			</div>
			<div className="flex h-[9px] gap-0.5 overflow-hidden rounded-full bg-surface-sunken">
				{meter.segments.map((s) =>
					s.count > 0 ? (
						<div
							key={s.key}
							title={`${s.label}: ${s.count}`}
							className={cn("min-w-[3px]", TONE_BAR[s.tone])}
							style={{ flexGrow: s.count }}
						/>
					) : null,
				)}
				{total === 0 && <div className="flex-1" />}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				{meter.segments.map((s) => (
					<span
						key={s.key}
						className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-text-tertiary"
					>
						<span
							className={cn("size-[9px] shrink-0 rounded-[2px]", TONE_BAR[s.tone])}
						/>
						{s.label}&nbsp;
						<b className="font-semibold text-text-primary">{s.count}</b>
					</span>
				))}
			</div>
		</div>
	);
}

/** The three-meter strip above the triage clusters. */
export function EvidenceMeters({ meters }: { meters: Meter[] }) {
	return (
		<div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
			{meters.map((m) => (
				<MeterCard key={m.key} meter={m} />
			))}
		</div>
	);
}
