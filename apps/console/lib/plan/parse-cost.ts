// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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

export function parseCostBreakdown(
	costData: Record<string, unknown>,
): CostSummary {
	const totalMonthlyCost = parseFloat(
		(costData.totalMonthlyCost as string) || "0",
	);
	const totalHourlyCost = parseFloat(
		(costData.totalHourlyCost as string) || "0",
	);

	const resources: CostResource[] = [];

	const projects = (costData.projects as Record<string, unknown>[]) || [];
	for (const project of projects) {
		const breakdown =
			(project.breakdown as Record<string, unknown>) || {};
		const rawResources =
			(breakdown.resources as Record<string, unknown>[]) || [];

		for (const r of rawResources) {
			const monthlyCost = r.monthlyCost
				? parseFloat(r.monthlyCost as string)
				: null;
			const hourlyCost = r.hourlyCost
				? parseFloat(r.hourlyCost as string)
				: null;

			if (monthlyCost === 0 || monthlyCost === null) continue;

			const subResources: CostSubResource[] = [];
			const subs =
				(r.subresources as Record<string, unknown>[]) || [];
			for (const sub of subs) {
				const subCost = sub.monthlyCost
					? parseFloat(sub.monthlyCost as string)
					: null;
				if (subCost === 0 || subCost === null) continue;
				subResources.push({
					name: sub.name as string,
					monthlyCost: subCost,
				});
			}

			resources.push({
				name: r.name as string,
				resourceType: (r.resourceType as string) || "",
				monthlyCost,
				hourlyCost,
				subResources,
			});
		}
	}

	resources.sort((a, b) => (b.monthlyCost ?? 0) - (a.monthlyCost ?? 0));

	return {
		totalMonthlyCost: isNaN(totalMonthlyCost) ? null : totalMonthlyCost,
		totalHourlyCost: isNaN(totalHourlyCost) ? null : totalHourlyCost,
		resources,
	};
}
