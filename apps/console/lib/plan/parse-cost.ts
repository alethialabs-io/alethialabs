// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

export interface CostSubResource {
	name: string;
	monthlyCost: number | null;
}

export interface CostResource {
	name: string;
	resourceType: string;
	monthlyCost: number | null;
	hourlyCost: number | null;
	subResources: CostSubResource[];
}

export interface CostSummary {
	totalMonthlyCost: number | null;
	totalHourlyCost: number | null;
	resources: CostResource[];
}

// Infracost emits every cost as a decimal STRING (e.g. "142.50"). Coerce to a number —
// null when the field is absent/blank, and (defensively) when it can't be parsed — so a
// malformed breakdown degrades to "unknown cost" instead of surfacing NaN or throwing.
const optionalCost = z
	.unknown()
	.optional()
	.transform((v): number | null => {
		if (!v) return null;
		const n = parseFloat(String(v));
		return Number.isNaN(n) ? null : n;
	});

/** Like {@link optionalCost} but defaults an absent/blank total to 0 (matches Infracost). */
const totalCost = z
	.unknown()
	.optional()
	.transform((v): number | null => {
		const n = parseFloat(v ? String(v) : "0");
		return Number.isNaN(n) ? null : n;
	});

const costResourceSchema = z.object({
	name: z.string().catch(""),
	resourceType: z.string().catch(""),
	monthlyCost: optionalCost,
	hourlyCost: optionalCost,
	subresources: z
		.array(z.object({ name: z.string().catch(""), monthlyCost: optionalCost }))
		.catch([]),
});

// The full Infracost breakdown JSON. Every level is lenient (`.catch`) so a partial or
// unexpected payload never throws — it collapses to empties, matching the old cast-based reader.
const costBreakdownSchema = z
	.object({
		totalMonthlyCost: totalCost,
		totalHourlyCost: totalCost,
		projects: z
			.array(
				z.object({
					breakdown: z
						.object({ resources: z.array(costResourceSchema).catch([]) })
						.catch({ resources: [] }),
				}),
			)
			.catch([]),
	})
	.catch({ totalMonthlyCost: null, totalHourlyCost: null, projects: [] });

/** Parses an Infracost breakdown into the ranked, cost-bearing resource list the Plan tab renders. */
export function parseCostBreakdown(
	costData: Record<string, unknown>,
): CostSummary {
	const data = costBreakdownSchema.parse(costData);

	const resources: CostResource[] = [];
	for (const project of data.projects) {
		for (const r of project.breakdown.resources) {
			// Skip free / cost-unknown resources — the panel only ranks priced ones.
			if (r.monthlyCost === 0 || r.monthlyCost === null) continue;
			const subResources = r.subresources.filter(
				(s) => s.monthlyCost !== 0 && s.monthlyCost !== null,
			);
			resources.push({
				name: r.name,
				resourceType: r.resourceType,
				monthlyCost: r.monthlyCost,
				hourlyCost: r.hourlyCost,
				subResources,
			});
		}
	}

	resources.sort((a, b) => (b.monthlyCost ?? 0) - (a.monthlyCost ?? 0));

	return {
		totalMonthlyCost: data.totalMonthlyCost,
		totalHourlyCost: data.totalHourlyCost,
		resources,
	};
}
