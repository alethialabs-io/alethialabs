// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client-safe filter/query plumbing for the Evidence page (the console filter
// standard's "normalize" step — see lib/query/README.md → "Server-side filters").
// No React, no DB imports: the values below mirror the `cloud_provider` DB enum and
// @repo/ui's PROVIDER_LABELS, with a unit drift-guard asserting all three stay in sync
// (tests/components/evidence/evidence-query.test.ts).

/** The filterable clouds — mirrors `cloudProvider.enumValues` (lib/db/schema/enums.ts). */
export const CLOUD_FILTER_VALUES = [
	"aws",
	"azure",
	"gcp",
	"alibaba",
	"digitalocean",
	"hetzner",
	"civo",
] as const;

export type CloudFilterValue = (typeof CLOUD_FILTER_VALUES)[number];

const CLOUD_SET = new Set<string>(CLOUD_FILTER_VALUES);

/** The catch-all provider bucket for rows whose provider is null, "mixed", or unknown. */
export const OTHER_PROVIDER = "other";

/** The provider facet key a row falls under: its cloud, or the "other" bucket. */
export function providerKey(provider: string | null): string {
	return provider !== null && CLOUD_SET.has(provider)
		? provider
		: OTHER_PROVIDER;
}

/** The Evidence page's filter state (the shape its zustand store holds). */
export interface EvidenceFilters {
	search: string;
	stages: string[];
	status: string[];
	providers: string[];
}

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_EVIDENCE_FILTERS: EvidenceFilters = {
	search: "",
	stages: [],
	status: [],
	providers: [],
};

/**
 * The stable query object placed in the TanStack key and sent to `getOrgEvidence`.
 * Only non-empty fields are present, and arrays are sorted + deduped, so two
 * equivalent filter states always produce an identical key (no cache fragmentation).
 */
export interface NormalizedEvidenceQuery {
	search?: string;
	stages?: string[];
	status?: string[];
	providers?: string[];
}

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/** Normalize filter state into the stable query object (trim, sort, drop empties). */
export function normalizeEvidenceQuery(
	filters: EvidenceFilters,
): NormalizedEvidenceQuery {
	const query: NormalizedEvidenceQuery = {};
	const search = filters.search.trim();
	if (search) query.search = search;
	const stages = normalizeList(filters.stages);
	if (stages) query.stages = stages;
	const status = normalizeList(filters.status);
	if (status) query.status = status;
	const providers = normalizeList(filters.providers);
	if (providers) query.providers = providers;
	return query;
}
