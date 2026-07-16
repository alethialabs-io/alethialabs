// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The Evidence page's data hook — the filter standard's fetch step: filter store →
// debounced search → normalized query object → filter-in-key TanStack query →
// getOrgEvidence. keepPreviousData keeps the previous view rendered (dimmed via
// isPlaceholderData) while a filter change refetches.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { getOrgEvidence } from "@/app/server/actions/evidence";
import { normalizeEvidenceQuery } from "@/components/evidence/evidence-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { qk } from "@/lib/query/keys";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";

const SEARCH_DEBOUNCE = 300;

/** The org evidence roll-up for the current filter state (server-side filtering). */
export function useEvidenceQuery() {
	const { org } = useParams<{ org: string }>();
	const filters = useEvidenceFilters((s) => s.filters);
	const search = useDebouncedValue(filters.search, SEARCH_DEBOUNCE);
	const query = useMemo(
		() => normalizeEvidenceQuery({ ...filters, search }),
		[filters, search],
	);

	return useQuery({
		queryKey: qk.evidence(org, query),
		queryFn: () => getOrgEvidence(query),
		placeholderData: keepPreviousData,
	});
}
