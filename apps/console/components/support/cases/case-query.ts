// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client-safe filter/query plumbing for the "My cases" list — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React and
// no DB imports, mirroring components/evidence/evidence-query.ts, which is the reference
// implementation this list was migrated onto.
//
// EVERY FILTER IS APPLIED ON THE SERVER (#7396). The normalized query below IS the
// `support.cases` input, and so the query key: bucket, search, severity and type all reach
// `listCasesForOwner`'s SQL, so a filter finds a case on any page, not only the pages loaded so
// far. A pristine query is `{ bucket }` alone — the key `my-cases/page.tsx` prefetches for a bare
// link — and the route prefetches the link's full normalized query too, so a filtered link also
// paints from the server.
//
// Facet counts come from the server as well: the read's first page carries them, counted over the
// caller's UNFILTERED cases (the scope is RLS; the bucket is a filter like the others), so an
// option never vanishes as it is selected. Only the labels are client-side.

import { coerceEnum } from "@/lib/coerce";
import { caseLabel } from "@/lib/support/case-status";
import type { FacetOption } from "@/lib/queries/facets";
import type { ResourceKind } from "@/lib/db/schema/enums";

/**
 * The classification resource kind of a support case. One constant for the case view's
 * `ClassificationControl` and the route that prefetches its reads (#6336): the prefetch only hits
 * when both key the chips with the same kind, and this module is the one both sides can import
 * (no "use client", no server-only import).
 */
export const CASE_RESOURCE_KIND: ResourceKind = "support_case";

/** The lifecycle buckets `listCasesForOwner` understands; "all" means no server filter. */
export const CASE_BUCKETS = ["all", "active", "resolved"] as const;

export type CaseBucket = (typeof CASE_BUCKETS)[number];

/** Chip labels for the bucket group, in display order. */
export const CASE_BUCKET_LABELS: Record<CaseBucket, string> = {
	all: "All",
	active: "Active",
	resolved: "Resolved",
};

/**
 * The "My cases" filter state (the shape its zustand store holds). A type alias rather
 * than an interface so it satisfies the store / url-sync generics' `Record` constraints
 * via the implicit index signature.
 */
export type SupportCaseFilters = {
	/** Lifecycle bucket (all / active / resolved). */
	bucket: string;
	/** Free text over the case reference and subject. */
	search: string;
	/** Selected `support_case_severity` values; empty means every severity. */
	severity: string[];
	/** Selected `support_case_type` values; empty means every type. */
	type: string[];
};

/**
 * The lifecycle bucket is the only filter the URL renames — `?status=active` reads better than
 * `?bucket=active`. Shared by the list's URL sync and the route's prefetch, which must decode the
 * same link into the same key.
 */
export const CASE_LIST_PARAM_NAMES: Partial<Record<keyof SupportCaseFilters, string>> = {
	bucket: "status",
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_SUPPORT_CASE_FILTERS: SupportCaseFilters = {
	bucket: "all",
	search: "",
	severity: [],
	type: [],
};

/** The stable, normalized query the list renders from. */
export interface NormalizedSupportCaseQuery {
	/** Always present — a pristine query is `{ bucket: "all" }`, the key a bare link prefetches. */
	bucket: CaseBucket;
	search?: string;
	severity?: string[];
	type?: string[];
}

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/**
 * Normalize filter state into the stable query object (trim, sort, drop empties). Two
 * equivalent filter states always produce a deep-equal result, so they share one query key
 * and a no-op change never refetches.
 */
export function normalizeSupportCaseQuery(
	filters: SupportCaseFilters,
): NormalizedSupportCaseQuery {
	const query: NormalizedSupportCaseQuery = {
		bucket: coerceEnum(filters.bucket, CASE_BUCKETS, "all"),
	};
	const search = filters.search.trim();
	if (search) query.search = search;
	const severity = normalizeList(filters.severity);
	if (severity) query.severity = severity;
	const type = normalizeList(filters.type);
	if (type) query.type = type;
	return query;
}

/** Formats a case number as the zero-padded `CASE-000123` reference (the one `caseLabel`). */
export function formatCaseNumber(caseNumber: number): string {
	return caseLabel(caseNumber);
}

/** One facet option: the value, how many rows carry it, and its display label. */
export interface CaseFacetOption {
	value: string;
	label: string;
	count: number;
}

/**
 * The server's facet counts for one dimension as the bar's options: labelled, in the order of
 * `labels` (not the data's, so the list does not reshuffle as counts change), keeping only values
 * the caller's cases carry. The counts were taken over the unfiltered cases (`queryCasesPage`), so
 * an option stays put while it is selected. `counts` is undefined before the first page lands.
 */
export function caseFacetOptions(
	counts: readonly FacetOption[] | undefined,
	labels: Record<string, string>,
): CaseFacetOption[] {
	const byValue = new Map((counts ?? []).map((o) => [o.value, o.count]));
	return Object.keys(labels)
		.filter((value) => byValue.has(value))
		.map((value) => ({
			value,
			label: labels[value],
			count: byValue.get(value) ?? 0,
		}));
}
