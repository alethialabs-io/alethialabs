// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getOrgEvidence } from "@/app/server/actions/evidence";
import { EvidenceClient } from "@/components/evidence/evidence-client";
import {
	filtersFromSearchParams,
	normalizeEvidenceQuery,
} from "@/components/evidence/evidence-query";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Evidence",
	description:
		"Proof that your infrastructure is what you provisioned: verification verdicts, drift posture, and recorded waivers across every environment.",
});

/**
 * Evidence route — the org-wide day-2 "keep proving it" roll-up. Parses the filter
 * search params (the URL half of the filter standard) and prefetches exactly that
 * query, so a shared filtered link hydrates into the view it shows; `loading.tsx`
 * covers the query window. The client then refetches through the same server action
 * whenever a filter changes (filter-in-key TanStack query).
 */
export default async function EvidenceRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const [{ org }, sp] = await Promise.all([params, searchParams]);
	const query = normalizeEvidenceQuery(filtersFromSearchParams(sp));

	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.evidence(org, query),
		queryFn: () => getOrgEvidence(query),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<EvidenceClient />
		</HydrationBoundary>
	);
}
