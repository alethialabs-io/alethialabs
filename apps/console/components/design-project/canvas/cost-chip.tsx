"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMonthlyRate } from "@repo/format";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";

/**
 * What this environment costs — the headline number the product could never answer.
 *
 * The runner has always run Infracost on every PLAN and posted the breakdown; nobody ever wrote it
 * down, so "what does production cost?" had nowhere to look. Now it does.
 *
 * Never priced = we genuinely don't know, and the chip says NOTHING rather than either a
 * fabricated $0.00 (worse than an admitted unknown, because you'd believe it) or a dashed "Not
 * priced" pill sitting in the toolbar of every fresh environment — a label for an absence, on the
 * row that is meant to ease a first visit in. The node cards, the Cost tab and the assistant all
 * still say "not priced yet" where the question is actually asked.
 */
export function CostChip() {
	const env = useEnvironmentStatus();

	if (env.monthlyCost == null) return null;

	return (
		<span
			className="flex h-8 items-center gap-2 border border-border bg-card px-2.5"
			title={
				env.costCapturedAt
					? `From the plan on ${new Date(env.costCapturedAt).toLocaleString()}`
					: undefined
			}
		>
			{/* No "Monthly" eyebrow: `formatMonthlyRate` carries its own `/mo`, and "Monthly
			    $12.50/mo" labels the period twice in a chip whose constraint is horizontal
			    space. `exact` because the node cards on the same canvas are the parts of this
			    number, and a total that rounds differently from its parts cannot be checked. */}
			<span className="font-mono text-xs text-foreground">
				{formatMonthlyRate(env.monthlyCost, "exact")}
			</span>
		</span>
	);
}
