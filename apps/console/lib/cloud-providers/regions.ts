// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #940b (#969): barrel shim over the generated catalog baseline (#1126). The region data
// (per-provider native labels, per-provider default, cross-provider conversion map) is now generated
// from the single source of truth (packages/core/catalog/catalog.json → generated/catalog.ts) and
// re-exported here verbatim — same paths + symbols, ZERO behaviour change. Only `groupRegions` (a pure
// helper over that data, not catalog data itself) still lives here. #940c deletes this shim + repoints
// importers straight at the generated module.
import type { CloudProviderSlug } from "./registry";
import { REGION_LABELS } from "./generated/catalog";

export { REGION_LABELS, DEFAULT_REGION, REGION_MAP } from "./generated/catalog";

/** Groups region codes into geographic sections using the registry labels. */
export function groupRegions(codes: string[], provider: CloudProviderSlug) {
	const labels = REGION_LABELS[provider] ?? {};
	const grouped = new Map<string, Array<{ value: string; label: string }>>();
	for (const code of codes) {
		const meta = labels[code];
		const group = meta?.group ?? "Other";
		const label = meta?.label ?? code;
		if (!grouped.has(group)) grouped.set(group, []);
		grouped.get(group)!.push({ value: code, label });
	}
	return Array.from(grouped.entries()).map(([group, regions]) => ({
		group,
		regions: regions.sort((a, b) => a.label.localeCompare(b.label)),
	}));
}
