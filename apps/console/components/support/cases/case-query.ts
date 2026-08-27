// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client-safe filter/query plumbing for the "My cases" list — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React and
// no DB imports, mirroring components/evidence/evidence-query.ts, which is the reference
// implementation this list was migrated onto.
//
// WHERE EACH FILTER IS APPLIED, and why they differ:
//
//   bucket (all / active / resolved)  →  SERVER. `listMyCases({ status })` takes exactly
//                                        this one argument, and it is the only dimension
//                                        the query key varies on, so `qk.supportCases(bucket)`
//                                        stays byte-identical to the key `my-cases/page.tsx`
//                                        prefetches and `use-support-cases-query.ts` polls.
//                                        Hydration hits on first paint because of that.
//
//   search / severity / type          →  CLIENT, over the rows the bucket returned.
//                                        `listMyCases` accepts no other filter and the action
//                                        is outside this change's scope (#2880 scopes to
//                                        components/support/** + lib/stores/use-support-filters.ts).
//                                        They are deliberately NOT in the query key: keying on a
//                                        dimension the server never sees only fragments the cache
//                                        and breaks the prefetch match, so the refinement runs as
//                                        a pure predicate here instead.
//
// Widening `listMyCases` (and computing the facet counts server-side over the unfiltered
// universe, as the standard prescribes) is the follow-up that makes those two client-side
// dimensions server-side; the shape here does not change when it lands, only where
// `matchesSupportCaseQuery` runs.

import { coerceEnum } from "@/lib/coerce";
import type { CaseListItem } from "@/lib/queries/support";

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
	/** Lifecycle bucket — the one dimension the server action filters on. */
	bucket: string;
	/** Free text over the case reference and subject. */
	search: string;
	/** Selected `support_case_severity` values; empty means every severity. */
	severity: string[];
	/** Selected `support_case_type` values; empty means every type. */
	type: string[];
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
	/** Always present — it is the query key's only variable, so it may not be dropped. */
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
 * equivalent filter states always produce a deep-equal result, so the memoised refinement
 * downstream never re-runs on a no-op change.
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

/**
 * The argument `listMyCases` takes for a bucket. "all" is the absence of a filter, not a
 * value the action accepts, so it maps to `{}` rather than `{ status: "all" }`.
 */
export function serverFilterForBucket(
	bucket: CaseBucket,
): { status?: "active" | "resolved" } {
	return bucket === "all" ? {} : { status: bucket };
}

/** Formats a case number as the zero-padded `CASE-000123` reference. */
export function formatCaseNumber(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}

/**
 * The text a search term is matched against: the subject, the padded reference, and the
 * bare number — so "123", "case-000123" and a subject word all find the same row.
 */
function searchHaystack(row: CaseListItem): string {
	return `${row.subject} ${formatCaseNumber(row.case_number)} ${row.case_number}`.toLowerCase();
}

/**
 * True when one row survives the client-side half of the query (search / severity / type).
 * The bucket is NOT tested here — the server already applied it.
 */
export function matchesSupportCaseQuery(
	row: CaseListItem,
	query: NormalizedSupportCaseQuery,
): boolean {
	if (query.search && !searchHaystack(row).includes(query.search.toLowerCase())) {
		return false;
	}
	if (query.severity && !query.severity.includes(row.severity)) return false;
	if (query.type && !query.type.includes(row.type)) return false;
	return true;
}

/** One facet option: the value, how many rows carry it, and its display label. */
export interface CaseFacetOption {
	value: string;
	label: string;
	count: number;
}

/**
 * Facet option counts for one row field, computed over the rows the server returned
 * *before* any client-side refinement — the standard's rule that options must not
 * disappear as you select them. Options with no rows are dropped, and the order follows
 * `labels`, not the data, so the list does not reshuffle as counts change.
 *
 * The universe is the current bucket, not every case, because the bucket is a server
 * filter; that is the honest limit of computing facets client-side.
 */
export function caseFacetOptions(
	rows: CaseListItem[],
	field: "severity" | "type",
	labels: Record<string, string>,
): CaseFacetOption[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const value = row[field];
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return Object.keys(labels)
		.filter((value) => counts.has(value))
		.map((value) => ({
			value,
			label: labels[value],
			count: counts.get(value) ?? 0,
		}));
}
