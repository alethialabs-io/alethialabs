// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The headline counters above the Evidence tabs — a compact proof roll-up for the whole org.

import { cn } from "@repo/ui/utils";
import type { EvidenceSummary } from "@/lib/queries/evidence";

/** One stat tile: a big count over a muted label, emphasized when it needs attention. */
function Stat({
	label,
	value,
	emphasis = false,
}: {
	label: string;
	value: number;
	emphasis?: boolean;
}) {
	return (
		<div className="flex flex-col gap-0.5 rounded-lg border p-3">
			<span
				className={cn(
					"text-2xl font-semibold tabular-nums",
					emphasis && value > 0 ? "text-destructive" : "text-foreground",
				)}
			>
				{value}
			</span>
			<span className="text-xs text-muted-foreground">{label}</span>
		</div>
	);
}

/** The org-wide evidence counters strip. */
export function EvidenceSummaryStrip({ summary }: { summary: EvidenceSummary }) {
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
			<Stat label="Environments" value={summary.environments} />
			<Stat label="Verified" value={summary.verified} />
			<Stat label="Failing" value={summary.failing} emphasis />
			<Stat label="Warnings" value={summary.warning} />
			<Stat label="Drifted" value={summary.drifted} emphasis />
			<Stat label="Active waivers" value={summary.activeWaivers} emphasis />
		</div>
	);
}
