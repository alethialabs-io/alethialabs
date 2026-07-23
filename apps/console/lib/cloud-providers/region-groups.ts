// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// groupRegions — the pure region-grouping helper over the generated REGION_LABELS. Moved here when the
// regions.ts barrel shim was deleted in #940c; the region DATA is the generated catalog SSOT
// (./generated/catalog), this holds only the presentational grouping logic over it.

import { type CloudProviderSlug, REGION_LABELS } from "./generated/catalog";

/** Groups region codes into geographic sections using the catalog region labels. */
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
