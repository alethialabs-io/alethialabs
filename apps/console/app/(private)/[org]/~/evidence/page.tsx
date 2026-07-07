// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { fetchEvidenceData } from "@/lib/query/resource-fetchers";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { EvidenceClient } from "@/components/evidence/evidence-client";

export const metadata = pageMetadata({
	title: "Evidence",
	description:
		"Proof that your infrastructure is what you provisioned: verification verdicts, drift posture, and recorded waivers across every environment.",
});

/**
 * Evidence route — the org-wide day-2 "keep proving it" roll-up. Prefetches the evidence
 * aggregation (verify verdicts + drift posture + waivers) on the server and hydrates it so
 * the tables render on first paint; `loading.tsx` covers the prefetch window. The query
 * hook then polls on the day-2 cadence.
 */
export default async function EvidenceRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.evidence(org),
		queryFn: fetchEvidenceData,
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<EvidenceClient />
		</HydrationBoundary>
	);
}
